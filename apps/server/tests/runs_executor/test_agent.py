"""End-to-end wiring test: build_run_plan → build_agent_executor → WaveScheduler.

Drives the real ``engine.react_loop`` with a scripted fake provider (no network)
to prove the executor builds correct worker messages, folds results into
RunState, injects an upstream product into a downstream node's prompt, and emits
the ``run_*`` graph events.
"""

from agentcore.llm.protocol import LLMChunk, ToolCallDelta
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.facts import FactKind, TurnFactLog, current_fact_log
from agentcore.runtime.journal import completed_from_journal
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.executor import build_agent_executor
from agentcore.runtime.runs.types import RunPhase
from agentcore.runtime.runs.wave import WaveScheduler
from agentcore.tools.registry import ToolRegistry
from tests.runs_executor.conftest import (
    _ContentProvider,
    _ctx,
    _executor,
    _FileWriteTool,
    _gate,
    _GrantableTool,
    _MeteredRoundThenBoom,
    _OfferRecorder,
    _ResearchTool,
    _ScriptedRounds,
    _ToolCallThenContent,
    _UsageProvider,
)


async def test_parallel_workers_complete_with_usage():
    plan, errs = build_run_plan(
        [{"role": "A", "task": "做A"}, {"role": "B", "task": "做B"}], id_prefix="t"
    )
    assert errs == []
    provider = _ContentProvider(["AOUT", "BOUT"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert {s.phase for s in res.values()} == {RunPhase.COMPLETED}
    assert {s.content for s in res.values()} == {"AOUT", "BOUT"}
    assert all("input" in s.usage for s in res.values())


async def test_worker_usage_split_and_cost_priced():
    # Worker model resolves to deepseek-v4-flash (strong tier, dev-stage).
    # cache_miss 1M @ $0.14 + output 1M @ $0.28 = $0.42; cache_hit 1M @ $0.0028.
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    res = await WaveScheduler().run(plan, _executor(plan, _UsageProvider(), EventSink()))
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    # The cache split survives into RunState.usage (not collapsed to one input).
    assert state.usage["cache_hit"] == 1_000_000
    assert state.usage["cache_miss"] == 1_000_000
    # Cost is computed once, in nano-USD, on the state.
    assert state.cost["cached"] == 2_800_000  # 0.0028 USD
    assert state.cost["output"] == 280_000_000  # 0.28 USD
    assert state.cost["total"] == 2_800_000 + 140_000_000 + 280_000_000
    assert state.cost["currency"] == "USD"


async def test_dag_injects_upstream_product_downstream():
    tasks = [
        {"id": "s1", "role": "研究员", "task": "调研"},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs == []
    provider = _ContentProvider(["UPSTREAM-FACT", "FINAL"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert res["t_s1"].content == "UPSTREAM-FACT"
    assert res["t_s2"].content == "FINAL"
    downstream_user = provider.user_messages[1]
    assert "UPSTREAM-FACT" in downstream_user
    assert "研究员" in downstream_user
    assert "原始请求" in downstream_user


async def test_worker_prompt_carries_role_and_task():
    plan, _ = build_run_plan([{"role": "分析师", "task": "拆解需求"}], id_prefix="t")
    provider = _ContentProvider(["X"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    # The single request's user message carries the original request + the task.
    user = provider.user_messages[0]
    assert "原始请求" in user
    assert "拆解需求" in user


async def test_worker_identity_states_output_is_user_visible():
    """The worker's system prompt tells it the product is shown to the user directly
    (drillable in the UI) and flows back to the CEO — P2, to motivate self-contained,
    user-ready quality rather than writing only for the CEO."""
    plan, _ = build_run_plan([{"role": "分析师", "task": "拆解需求"}], id_prefix="t")
    provider = _ContentProvider(["X"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    system = provider.system_messages[0]
    assert "直接展示给用户" in system
    assert "可独立阅读" in system


async def test_run_lifecycle_events_emitted():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    sink = EventSink()
    provider = _ContentProvider(["X"])
    await WaveScheduler().run(plan, _executor(plan, provider, sink))
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.RUN_STARTED in types
    assert EventType.RUN_OUTPUT_DELTA in types
    assert EventType.RUN_COMPLETED in types


async def test_worker_reasoning_streamed_as_run_reasoning_delta():
    """A thinking worker's reasoning is streamed run-scoped (run_reasoning_delta),
    not discarded — so the team UI can show 思考全文 per run. The thinking stays on
    its own channel and never leaks into run_output_delta."""
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    sink = EventSink()

    class _ReasoningProvider:
        async def stream(self, request):
            yield LLMChunk(delta_reasoning="先拆解")
            yield LLMChunk(delta_reasoning="再对比")
            yield LLMChunk(delta_content="结论")

    await WaveScheduler().run(plan, _executor(plan, _ReasoningProvider(), sink))
    sink.close()
    events = [e async for e in sink]
    started = next(e for e in events if e.type == EventType.RUN_STARTED)
    agent_id = started.payload["agent_id"]

    reasoning = [e for e in events if e.type == EventType.RUN_REASONING_DELTA]
    assert [e.payload["delta"] for e in reasoning] == ["先拆解", "再对比"]
    assert all(e.payload["run_id"] == "t_1" for e in reasoning)
    assert all(e.payload["agent_id"] == agent_id for e in reasoning)
    # Thinking must not bleed into the output channel.
    output = [e for e in events if e.type == EventType.RUN_OUTPUT_DELTA]
    assert [e.payload["delta"] for e in output] == ["结论"]


async def test_completed_worker_run_final_fact_carries_full_output_and_reasoning():
    # 执行级事件溯源 (deltas 退场): a worker's FULL output + thinking are captured onto its
    # terminal RunState → its run_final_fact (``message_final``), so the reload rebuilds
    # the node's 输出/思考 from the fact (synthesizing the delta block) instead of the
    # no-longer-journaled per-token deltas. Drives the REAL executor under a bound fact
    # log and asserts the recorded fact carries both, full-text — closing the gap where
    # the worker's reasoning was previously discarded (only streamed, never a fact).
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")

    class _ReasoningProvider:
        async def stream(self, request):
            yield LLMChunk(delta_reasoning="先拆解")
            yield LLMChunk(delta_reasoning="再对比")
            yield LLMChunk(delta_content="结论")

    log = TurnFactLog()
    token = current_fact_log.set(log)
    try:
        res = await WaveScheduler().run(plan, _executor(plan, _ReasoningProvider(), EventSink()))
    finally:
        current_fact_log.reset(token)

    # The terminal RunState now carries the worker's thinking (previously left empty).
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert res["t_1"].content == "结论"
    assert res["t_1"].reasoning == "先拆解再对比"

    finals = [
        e
        for e in log.entries()
        if e["kind"] == FactKind.MESSAGE_FINAL.value and e["payload"].get("run_id") == "t_1"
    ]
    assert len(finals) == 1
    assert finals[0]["payload"]["content"] == "结论"
    assert finals[0]["payload"]["reasoning"] == "先拆解再对比"


async def test_run_started_carries_parent_and_kind_slots():
    """run_started pre-wires parent_run_id / kind (阶段2 声明位): a 阶段1 flat
    worker is a top-level ``agent`` — parent_run_id is None, kind == 'agent' —
    so nested delegation + synthesis need no event change."""
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    sink = EventSink()
    await WaveScheduler().run(plan, _executor(plan, _ContentProvider(["X"]), sink))
    sink.close()
    started = [e async for e in sink if e.type == EventType.RUN_STARTED]
    assert len(started) == 1
    payload = started[0].payload
    assert payload["parent_run_id"] is None
    assert payload["kind"] == "agent"
    assert payload["run_id"] == "t_1"


async def test_executor_failure_emits_run_failed_and_state():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    sink = EventSink()

    class _Boom:
        async def stream(self, request):
            raise RuntimeError("provider down")
            yield  # pragma: no cover - makes this an async generator

    executor = build_agent_executor(
        plan=plan,
        llm=_Boom(),
        tools=ToolRegistry(),
        sink=sink,
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    sink.close()
    assert res["t_1"].phase is RunPhase.FAILED
    assert "provider down" in res["t_1"].error
    types = [e.type async for e in sink]
    assert EventType.RUN_FAILED in types


async def test_worker_hard_failure_bills_completed_rounds():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    reg = ToolRegistry()
    reg.register(_GrantableTool("noop"))  # un-gated here → the metered round runs
    executor = build_agent_executor(
        plan=plan,
        llm=_MeteredRoundThenBoom(),
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.FAILED
    assert "provider down" in state.error
    # The round that completed before the crash is billed, not silently dropped.
    assert state.usage["cache_miss"] == 1000
    assert state.usage["output"] == 400
    assert state.cost["total"] > 0


async def test_failed_worker_run_final_fact_reseeds_from_journal():
    # 执行级事件溯源 Phase 2 ⑥ golden (FAILED arm): a FAILED worker journals its terminal
    # RunState at the SAME `execute` choke point as a COMPLETED one (run_final_fact covers
    # every phase), so `completed_from_journal` re-seeds it on resume — phase + error +
    # the billed pre-crash usage — not only COMPLETED nodes. Drives the REAL executor under
    # a bound fact log so the recording site + the projector are exercised together.
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    reg = ToolRegistry()
    reg.register(_GrantableTool("noop"))  # un-gated → the metered round runs before the boom
    executor = build_agent_executor(
        plan=plan,
        llm=_MeteredRoundThenBoom(),
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    log = TurnFactLog()
    token = current_fact_log.set(log)
    try:
        res = await WaveScheduler().run(plan, executor)
    finally:
        current_fact_log.reset(token)
    assert res["t_1"].phase is RunPhase.FAILED

    seed = completed_from_journal(log.entries())
    assert set(seed) == {"t_1"}
    assert seed["t_1"].phase is RunPhase.FAILED
    assert "provider down" in seed["t_1"].error
    # The billed pre-crash round survives the journal round-trip (a resume bills it once).
    assert seed["t_1"].usage["cache_miss"] == 1000


async def test_worker_failure_before_any_usage_has_no_ledger_row():
    # A run that dies before metering any tokens carries empty usage/cost, so the
    # per-run accumulator's `if state.usage` guard skips it — no spurious zero row.
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")

    class _BoomFirst:
        async def stream(self, request):  # noqa: ANN001
            raise RuntimeError("down")
            yield  # pragma: no cover

    executor = build_agent_executor(
        plan=plan,
        llm=_BoomFirst(),
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.FAILED
    assert not state.usage  # empty → accumulator skips → no ledger row
    assert not state.cost


async def test_contract_retry_then_pass():
    # min_length contract: first output too short → re-prompt → second passes.
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"min_length": 8}}], id_prefix="t"
    )
    provider = _ContentProvider(["短", "这是一段足够长的合格产出"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert provider.calls == 2
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert res["t_1"].content == "这是一段足够长的合格产出"
    assert res["t_1"].warnings == []
    # usage is summed across both attempts, not just the last one.
    assert res["t_1"].usage["input"] >= 0


async def test_contract_retry_continues_on_same_transcript_seeing_old_draft():
    # 统一「续写」: auto-rework no longer rebuilds the prompt from scratch — it
    # CONTINUES on the same transcript, so the worker sees its own prior draft
    # (assistant turn) with the shortfall appended as the last user turn (修隐患).
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"must_contain": ["风险"]}}], id_prefix="t"
    )
    provider = _ContentProvider(["没有那个词", "已包含风险二字"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    second = provider.requests[1]
    # the worker's own prior draft is in context now (was invisible before)
    assert any(role == "assistant" and content == "没有那个词" for role, content in second)
    # the shortfall is the LAST turn, a fresh user message (not folded into the task)
    last_role, last_content = second[-1]
    assert last_role == "user"
    assert "修正" in last_content
    assert "风险" in last_content


async def test_completed_run_captures_full_transcript():
    # T1/T2: a finished worker's full transcript is captured on RunState so the run
    # is recoverable (留人). It ends with the worker's final answer (react_loop omits
    # that append; the executor adds it) — the starting point for a 续写.
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    provider = _ContentProvider(["最终产出"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    transcript = res["t_1"].transcript
    assert transcript  # captured, not discarded
    assert transcript[0].role == "system"
    assert transcript[1].role == "user"
    assert "做A" in (transcript[1].content or "")
    # the final assistant answer is appended, so the transcript is replayable
    assert transcript[-1].role == "assistant"
    assert transcript[-1].content == "最终产出"


async def test_contract_requirements_stated_in_first_prompt():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"required_sections": ["结论"]}}], id_prefix="t"
    )
    provider = _ContentProvider(["# 结论\n好的"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert "产出要求" in provider.user_messages[0]
    assert "结论" in provider.user_messages[0]


async def test_worker_system_prompt_grants_structure_ownership():
    # 认知分工的接收端（L3，worker 侧所有权）: the CEO brake (test_prompt.py) tells the
    # CEO not to design the deliverable's structure; this is the counterpart that
    # reaches the WORKER — its system prompt must empower it to OWN the professional
    # structure and treat any skeleton leaked into the task as a starting suggestion
    # (checked against the 原始用户请求, also in its prompt) rather than a fill-in
    # template. Pins the fix so a refactor of the shared deliverable policy can't
    # silently revert the worker to a「填字员」. Verified end-to-end (assembled system
    # message), not just the constant, so the block must actually land in the prompt.
    plan, _ = build_run_plan([{"role": "写作者", "task": "写一篇文章"}], id_prefix="t")
    provider = _ContentProvider(["正文"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    sys = provider.system_messages[0]
    assert "专业结构" in sys
    assert "填字" in sys


async def test_contract_strict_hard_fails_after_retries():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"min_length": 50, "strict": True}}],
        id_prefix="t",
    )
    sink = EventSink()
    provider = _ContentProvider(["短", "还是短"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, sink))
    sink.close()
    assert provider.calls == 2
    assert res["t_1"].phase is RunPhase.FAILED
    assert "少于" in res["t_1"].error
    types = [e.type async for e in sink]
    assert EventType.RUN_FAILED in types


async def test_contract_soft_accepts_with_warning():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"min_length": 50}}], id_prefix="t"
    )
    provider = _ContentProvider(["短", "还是短"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert res["t_1"].content == "还是短"
    assert any("少于" in w for w in res["t_1"].warnings)


async def test_no_contract_passes_first_try_without_extra_call():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    provider = _ContentProvider(["一个正常的非空产出"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert provider.calls == 1  # no needless retry when the baseline is met
    assert res["t_1"].phase is RunPhase.COMPLETED


async def test_requires_files_reworks_when_not_written_then_passes_on_write():
    plan, _ = build_run_plan(
        [{"role": "前端", "task": "建页面", "contract": {"requires_files": True}}],
        id_prefix="t",
    )
    reg = ToolRegistry()
    fw = _FileWriteTool()
    reg.register(fw)
    rounds = [
        # attempt 1 (one round): only pastes the file into the reply, no file_write
        [LLMChunk(delta_content="<html>整份贴在聊天里</html>")],
        # attempt 2 round 1: call file_write; round 2: final answer
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="c1",
                        function_name="file_write",
                        arguments_delta='{"path": "index.html", "content": "<html></html>"}',
                    )
                ]
            )
        ],
        [LLMChunk(delta_content="已写入 index.html")],
    ]
    provider = _ScriptedRounds(rounds)
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    assert fw.calls == 1  # the rework actually wrote the file
    assert state.files_touched == ["index.html"]
    assert state.warnings == []


async def test_requires_files_soft_accepts_with_warning_when_never_written():
    # Non-strict: after the one rework the worker still never writes → accepted
    # (product isn't empty) but carries the shortfall as a warning, not a hard fail.
    plan, _ = build_run_plan(
        [{"role": "前端", "task": "建页面", "contract": {"requires_files": True}}],
        id_prefix="t",
    )
    provider = _ContentProvider(["只有文字一", "只有文字二"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert provider.calls == 2  # produced, reworked once, then soft-accepted
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    assert any("工作区" in w for w in state.warnings)
    assert state.files_touched == []


async def test_requires_files_strict_hard_fails_when_never_written():
    plan, _ = build_run_plan(
        [
            {
                "role": "前端",
                "task": "建页面",
                "contract": {"requires_files": True, "strict": True},
            }
        ],
        id_prefix="t",
    )
    sink = EventSink()
    provider = _ContentProvider(["只有文字一", "只有文字二"])
    res = await WaveScheduler().run(plan, _executor(plan, provider, sink))
    sink.close()
    state = res["t_1"]
    assert state.phase is RunPhase.FAILED
    assert "工作区" in state.error
    types = [e.type async for e in sink]
    assert EventType.RUN_FAILED in types


async def test_worker_grantable_tool_gated_when_gate_denies():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    tool = _GrantableTool()
    reg = ToolRegistry()
    reg.register(tool)
    provider = _ToolCallThenContent("code_execute", "{}", "done")
    # A 0.01s gate that nobody answers auto-denies — the worker must NOT run the
    # tool on the user's machine, and adapts to a denial tool-message.
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
        approval_gate=_gate(0.01),
    )
    res = await WaveScheduler().run(plan, executor)
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert tool.calls == 0  # denied → never executed


async def test_worker_grantable_tool_runs_without_gate():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    tool = _GrantableTool()
    reg = ToolRegistry()
    reg.register(tool)
    provider = _ToolCallThenContent("code_execute", "{}", "done")
    # No gate (the cloud default): the worker runs the tool un-gated, as before.
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert tool.calls == 1  # un-gated → executed


async def test_worker_with_omitted_tools_is_offered_all_team_tools():
    # Regression for the root bug: a delegated task that omits ``tools`` must NOT be
    # stranded tool-less. builder._tools → None → react_loop offers the whole
    # registry with tool_choice=auto, so a file/exec worker can actually act.
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    assert plan.nodes[0].tools is None
    reg = ToolRegistry()
    reg.register(_GrantableTool("code_execute"))
    provider = _OfferRecorder()
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert provider.offered and "code_execute" in provider.offered[0]
    assert provider.choices[0] == "auto"


async def test_worker_with_explicit_tools_is_restricted_to_them():
    # The opt-in least-privilege path still works: an explicit list narrows what the
    # worker is offered (web_search is registered but must NOT be offered).
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "tools": ["code_execute"]}],
        id_prefix="t",
        valid_tools={"code_execute", "web_search"},
    )
    assert plan.nodes[0].tools == ["code_execute"]
    reg = ToolRegistry()
    reg.register(_GrantableTool("code_execute"))
    reg.register(_GrantableTool("web_search"))
    provider = _OfferRecorder()
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    await WaveScheduler().run(plan, executor)
    assert provider.offered[0] == ["code_execute"]


async def test_collaboration_off_denies_note_tools_to_restricted_debater():
    # 团队便签去特例 (辩论): a debater is a RESTRICTED worker (DEBATER_TOOLS = web_search/read_url).
    # On a non-collaborative batch (collaboration=False, the debate path) the 团队便签 tools are
    # NOT force-added, so an adversarial debater is offered ONLY its own tools — no
    # post/read/amend_note, no way to broadcast its 立论 to the opposing side.
    plan, _ = build_run_plan(
        [{"role": "正方", "task": "立论", "tools": ["web_search"]}],
        id_prefix="t",
        valid_tools={"web_search"},
    )
    reg = ToolRegistry()
    reg.register(_GrantableTool("web_search"))
    reg.register(_GrantableTool("post_note"))
    reg.register(_GrantableTool("read_notes"))
    reg.register(_GrantableTool("amend_note"))
    provider = _OfferRecorder()
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
        collaboration=False,
    )
    await WaveScheduler().run(plan, executor)
    assert provider.offered[0] == ["web_search"]


async def test_collaboration_off_denies_note_tools_to_unrestricted_worker():
    # The switch means "no collaboration", not "no collaboration only if least-privilege": even
    # an UNRESTRICTED worker (tools omitted → "offer all team tools") is not handed the 团队便签
    # tools when collaboration=False — they are stripped from the offered registry.
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    assert plan.nodes[0].tools is None
    reg = ToolRegistry()
    reg.register(_GrantableTool("code_execute"))
    reg.register(_GrantableTool("post_note"))
    provider = _OfferRecorder()
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
        collaboration=False,
    )
    await WaveScheduler().run(plan, executor)
    assert "post_note" not in provider.offered[0]
    assert "code_execute" in provider.offered[0]


async def test_collaboration_on_grants_note_tools_to_restricted_worker():
    # The default (collaboration=True, the delegate path) is unchanged: even a least-privilege
    # worker keeps the 团队便签 broadcast channel so a collaborating team aligns mid-flight.
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "tools": ["web_search"]}],
        id_prefix="t",
        valid_tools={"web_search"},
    )
    reg = ToolRegistry()
    reg.register(_GrantableTool("web_search"))
    reg.register(_GrantableTool("post_note"))
    provider = _OfferRecorder()
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    await WaveScheduler().run(plan, executor)
    assert "post_note" in provider.offered[0]


async def test_worker_collects_web_citations_onto_runstate():
    cites = [{"url": "https://a.com", "title": "A", "snippet": "", "site": "a.com"}]
    plan, _ = build_run_plan([{"role": "研究员", "task": "调研"}], id_prefix="t")
    reg = ToolRegistry()
    reg.register(_ResearchTool(citations=cites))
    provider = _ToolCallThenContent("search", "{}", "FINAL")
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    # the worker's sources are aggregated onto RunState for the shared card
    assert state.citations == cites
    # the worker's own answer text is clean (un-numbered — annotation is CEO-only)
    assert state.content == "FINAL"
