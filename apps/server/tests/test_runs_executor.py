"""End-to-end wiring test: build_run_plan → build_agent_executor → WaveScheduler.

Drives the real ``engine.react_loop`` with a scripted fake provider (no network)
to prove the executor builds correct worker messages, folds results into
RunState, injects an upstream product into a downstream node's prompt, and emits
the ``run_*`` graph events.
"""

import tempfile
from pathlib import Path

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.protocol import LLMChunk, TokenUsage, ToolCallDelta
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.constants import DEP_CONTEXT_BUDGET
from agentcore.runtime.runs.executor import (
    _allocate,
    _build_messages,
    _dep_context_blocks,
    _is_hard_failure,
    _safe_index_files,
    _truncate_head_tail,
    _workspace_manifest,
    build_agent_executor,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunContract, RunPhase, RunSpec, RunState
from agentcore.runtime.runs.wave import WaveScheduler
from agentcore.tools.builtin.escalate import EscalateTool
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _ContentProvider:
    """Fake LLM: yields one scripted content chunk per call (no tool calls) and
    records each request's user message so dep-injection can be asserted.

    ``requests`` keeps the FULL (role, content) list per call so a continuation /
    auto-rework test can prove the worker sees its own prior draft + the appended
    instruction (统一「续写」原语)."""

    def __init__(self, contents: list[str]) -> None:
        self._contents = contents
        self.calls = 0
        self.user_messages: list[str] = []
        self.system_messages: list[str] = []
        self.requests: list[list[tuple[str, str]]] = []

    async def stream(self, request):
        self.requests.append([(m.role, m.content or "") for m in request.messages])
        user = next((m.content for m in request.messages if m.role == "user"), "")
        self.user_messages.append(user or "")
        system = next((m.content for m in request.messages if m.role == "system"), "")
        self.system_messages.append(system or "")
        text = self._contents[self.calls] if self.calls < len(self._contents) else "done"
        self.calls += 1
        yield LLMChunk(delta_content=text)


# An isolated, EMPTY workspace root for the fake-provider runs: their tool stubs
# never actually write to disk, so index_files() over this root is a clean [] —
# keeping the worker workspace manifest deterministic (and off the polluted /
# huge cwd tree that Path(".") would walk every run).
_WS_ROOT = Path(tempfile.mkdtemp(prefix="exec-ws-"))


def _ctx() -> ToolContext:
    # These fake-provider runs never invoke a real tool, so the backend is inert — it
    # only has to satisfy the ToolContext contract and answer index_files() (empty).
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=_WS_ROOT, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _executor(plan: RunPlan, provider: _ContentProvider, sink: EventSink):
    return build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=sink,
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
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


class _UsageProvider:
    """Fake LLM that reports a usage chunk so the executor can price the run.
    Splits input into cache hit/miss to prove the split survives to RunState."""

    async def stream(self, request):
        yield LLMChunk(delta_content="OUT")
        yield LLMChunk(
            usage=TokenUsage(
                input_tokens=2_000_000,
                cache_hit_tokens=1_000_000,
                cache_miss_tokens=1_000_000,
                output_tokens=1_000_000,
            )
        )


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
    from agentcore.runtime.facts import FactKind, TurnFactLog, current_fact_log

    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")

    class _ReasoningProvider:
        async def stream(self, request):
            yield LLMChunk(delta_reasoning="先拆解")
            yield LLMChunk(delta_reasoning="再对比")
            yield LLMChunk(delta_content="结论")

    log = TurnFactLog()
    token = current_fact_log.set(log)
    try:
        res = await WaveScheduler().run(
            plan, _executor(plan, _ReasoningProvider(), EventSink())
        )
    finally:
        current_fact_log.reset(token)

    # The terminal RunState now carries the worker's thinking (previously left empty).
    assert res["t_1"].phase is RunPhase.COMPLETED
    assert res["t_1"].content == "结论"
    assert res["t_1"].reasoning == "先拆解再对比"

    finals = [
        e
        for e in log.entries()
        if e["kind"] == FactKind.MESSAGE_FINAL.value
        and e["payload"].get("run_id") == "t_1"
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


class _MeteredRoundThenBoom:
    """Round 0: a tool call + usage chunk (the loop meters it and continues);
    round 1: raises. Proves a hard worker failure still bills the round that
    completed before the crash (B-deep 失败计费), instead of dropping its tokens."""

    def __init__(self) -> None:
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        c = self.calls
        self.calls += 1
        if c == 0:
            yield LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(index=0, id="c1", function_name="noop", arguments_delta="{}")
                ]
            )
            yield LLMChunk(
                usage=TokenUsage(input_tokens=1000, cache_miss_tokens=1000, output_tokens=400)
            )
            return
        raise RuntimeError("provider down")
        yield  # pragma: no cover - makes this an async generator


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
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from agentcore.runtime.journal import completed_from_journal

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


# --- requires_files: the deliverable-landed gate (soft prompt rule → code门) ----
#
# A contract with requires_files=True fails the run when its transcript shows ZERO
# file-writing tool calls — turning「文件交付物必须落盘、别整份粘进聊天」from a soft
# prompt instruction into a verifiable gate that auto-reworks. The signal is the
# deterministic files_touched (real tool-call records), not a content heuristic.


class _ScriptedRounds:
    """Fake LLM yielding a pre-scripted chunk list per call (one call = one ReAct
    round), so a test can script a multi-round attempt that calls file_write.

    Records each call's first user message so a DAG test can assert what context
    (e.g. a 递指针 pointer block) reached a downstream worker's prompt."""

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0
        self.user_messages: list[str] = []

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        user = next((m.content for m in request.messages if m.role == "user"), "")
        self.user_messages.append(user or "")
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else [
            LLMChunk(delta_content="done")
        ]
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _FileWriteTool:
    """A stub named ``file_write`` (the name files_touched_from_transcript keys on);
    it records calls and reports success so the gate sees a landed file."""

    def __init__(self) -> None:
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_write",
            description="stub file write",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            },
            category=ToolCategory.EXECUTION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        return ToolResult(tool_call_id="", success=True, output="written")


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


# --- worker approval gate (双模式工作区 P2d 执行门) -------------------------
#
# build_agent_executor forwards an approval_gate into each worker's react_loop, so
# a delegated worker's GRANTABLE tool (e.g. code_execute) is gated exactly like the
# CEO's. The DelegateTool only passes a gate in LOCAL mode; these tests pin the
# executor half (gate present → gated; absent → un-gated, the cloud default).


class _ToolCallThenContent:
    """Fake LLM: round 1 calls a tool, round 2 returns content (no network)."""

    def __init__(self, tool_name: str, args: str, content: str) -> None:
        self._rounds = [
            [
                LLMChunk(
                    delta_tool_calls=[
                        ToolCallDelta(
                            index=0, id="c1", function_name=tool_name, arguments_delta=args
                        )
                    ]
                )
            ],
            [LLMChunk(delta_content=content)],
        ]
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _GrantableTool:
    """A GRANTABLE stub recording whether it actually executed."""

    def __init__(self, name: str = "code_execute") -> None:
        self._name = name
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub grantable",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.EXECUTION,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        return ToolResult(tool_call_id="", success=True, output="ran")


def _gate(timeout_seconds: float) -> ApprovalGate:
    return ApprovalGate(
        sink=EventSink(),
        conversation_id="conv-1",
        registry=InteractionRegistry(),
        timeout_seconds=timeout_seconds,
    )


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


class _OfferRecorder:
    """Fake LLM that records the tool definitions it was OFFERED each call (proves
    the allowed_tool_names wiring), then yields one content chunk and stops."""

    def __init__(self) -> None:
        self.offered: list[list[str]] = []
        self.choices: list[str] = []

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        self.offered.append([t["function"]["name"] for t in (request.tools or [])])
        self.choices.append(request.tool_choice)
        yield LLMChunk(delta_content="DONE")


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


# --- worker web sources → RunState (方案 B) ---------------------------------
#
# The executor passes each worker's react_loop a per-run citation sink with
# annotate_citations=False, then stores the collected sources on RunState. The
# DelegateTool later folds these into the turn's shared source card, so the user
# sees the WHOLE team's research — not just the CEO's own searches.


class _ResearchTool:
    """A SEARCH stub returning fixed citations (proves the executor collects a
    worker's web sources onto RunState)."""

    def __init__(self, name: str = "search", citations=None) -> None:  # noqa: ANN001
        self._name = name
        self._citations = citations or []
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub search",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        return ToolResult(
            tool_call_id="", success=True, output="result", citations=self._citations
        )


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


def test_is_hard_failure_empty_always_hard():
    assert _is_hard_failure("   ", None) is True
    assert _is_hard_failure("", RunContract(strict=False)) is True


def test_is_hard_failure_nonempty_depends_on_strict():
    assert _is_hard_failure("x", None) is False
    assert _is_hard_failure("x", RunContract(strict=False)) is False
    assert _is_hard_failure("x", RunContract(strict=True)) is True


# --- 阶段2 嵌套子任务: the executor's depth-cap gate on handing a delegate tool --
#
# The executor mints a worker's nested delegate (via the injected factory) ONLY
# when the worker opted in AND is still above the depth cap. These pin that gate
# without driving a real nested run (the end-to-end path lives in test_delegate).


class _StubDelegate:
    """A minimal ORCHESTRATION tool named 'delegate' — never executed here; the
    fake LLM emits no tool call, so we only assert it was (or wasn't) minted."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="delegate",
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        return ToolResult(tool_call_id="", success=True, output="")


def _spec(run_id: str, *, depth: int, can_delegate: bool):
    from agentcore.runtime.runs.types import RunSpec

    return RunSpec(
        run_id=run_id,
        agent_id=run_id,
        role="W",
        task="t",
        depth=depth,
        can_delegate=can_delegate,
    )


def _nesting_executor(plan: RunPlan, provider, factory):
    return build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
        delegate_factory=factory,
    )


async def test_nested_delegate_offered_only_within_depth_cap():
    calls: list[tuple[str, int]] = []

    def factory(captain_run_id: str, captain_depth: int):
        calls.append((captain_run_id, captain_depth))
        return _StubDelegate()

    plan = RunPlan()
    plan.add(_spec("d1", depth=1, can_delegate=True))
    plan.add(_spec("d2", depth=2, can_delegate=True))  # at the cap
    executor = _nesting_executor(plan, _ContentProvider(["X", "Y"]), factory)
    await executor(plan.by_id("d1"), {})
    await executor(plan.by_id("d2"), {})
    # The depth-1 worker (above the cap) is handed a delegate tool bound to itself;
    # the depth-2 worker (at the cap) never is, even though it also opted in.
    assert calls == [("d1", 1)]


async def test_nested_delegate_withheld_without_opt_in():
    calls: list[str] = []

    def factory(captain_run_id: str, captain_depth: int):
        calls.append(captain_run_id)
        return _StubDelegate()

    plan = RunPlan()
    plan.add(_spec("d1", depth=1, can_delegate=False))
    executor = _nesting_executor(plan, _ContentProvider(["X"]), factory)
    await executor(plan.by_id("d1"), {})
    assert calls == []  # no opt-in → leaf worker, no delegate tool


async def test_captain_worker_gets_captain_identity_and_delegate_tool():
    provider = _ContentProvider(["X"])
    plan = RunPlan()
    plan.add(_spec("d1", depth=1, can_delegate=True))
    executor = _nesting_executor(plan, provider, lambda rid, d: _StubDelegate())
    await executor(plan.by_id("d1"), {})
    # The opted-in, above-cap worker is told it may lead one nested sub-team.
    assert "再向下委派一层子团队" in provider.system_messages[0]


async def test_leaf_worker_keeps_no_nesting_identity():
    provider = _ContentProvider(["X"])
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    # A factory is available, but the leaf worker did not opt in → leaf identity.
    executor = _nesting_executor(plan, provider, lambda rid, d: _StubDelegate())
    await executor(plan.by_id("t_1"), {})
    assert "不能再向下委派" in provider.system_messages[0]
    assert "再向下委派一层子团队" not in provider.system_messages[0]


# --- worker → CEO escalation channel (escalate tool) ---------------------------
#
# A worker that hits a fork only the user/上级 can settle calls ``escalate`` (its
# only upward channel — it can't reach the user). It is NON-blocking: the worker
# proceeds on its assumption and still COMPLETES; the escalation is harvested onto
# RunState for the CEO to surface and resolve (ask_user / revise / re-delegate).


async def test_worker_escalation_is_harvested_and_nonblocking():
    plan, _ = build_run_plan([{"role": "调研", "task": "查不清楚的事"}], id_prefix="t")
    reg = ToolRegistry()
    reg.register(EscalateTool())
    rounds = [
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="c1",
                        function_name="escalate",
                        arguments_delta=(
                            '{"question": "用 Postgres 还是 MySQL?", '
                            '"assumption": "暂用 Postgres", "blocking": true}'
                        ),
                    )
                ]
            )
        ],
        [LLMChunk(delta_content="已按 Postgres 完成调研")],
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
    assert state.phase is RunPhase.COMPLETED  # non-blocking: it still delivered
    assert state.content == "已按 Postgres 完成调研"
    assert len(state.escalations) == 1
    esc = state.escalations[0]
    assert esc["question"] == "用 Postgres 还是 MySQL?"
    assert esc["assumption"] == "暂用 Postgres"
    assert esc["blocking"] is True


async def test_worker_without_escalation_has_empty_list():
    plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="t")
    res = await WaveScheduler().run(
        plan, _executor(plan, _ContentProvider(["OUT"]), EventSink())
    )
    assert res["t_1"].escalations == []


async def test_escalate_tool_rejects_empty_question_and_acks_otherwise():
    tool = EscalateTool()
    bad = await tool.execute({"question": "  "}, _ctx())
    assert bad.success is False and "question" in (bad.error or "")
    # A valid escalation is acknowledged with a CONTINUE (non-terminal) result that
    # steers the worker to keep delivering — it is not a stop.
    ok = await tool.execute({"question": "Postgres 还是 MySQL?"}, _ctx())
    assert ok.success is True and ok.is_terminal is False
    assert "继续" in ok.output


# --- upstream dependency context budget (shared, water-filled, head+tail) -------
#
# A downstream node's pass_through deps SHARE one budget (DEP_CONTEXT_BUDGET),
# water-filled across them; overflow is head+tail trimmed so trailing details
# (金额 / 法条编号) survive — replacing the old flat 4000-per-dep head-only cap.


def test_allocate_single_dep_gets_whole_budget():
    assert _allocate([10_000], 16_000) == [10_000]  # fits → full content
    assert _allocate([50_000], 16_000) == [16_000]  # over → capped at the budget


def test_allocate_water_fills_unequal_deps():
    # The small dep takes only what it needs; the freed remainder goes to the big one
    # (not an even split that would starve the big dep and waste the small's share).
    out = _allocate([1_000, 50_000], 16_000)
    assert out == [1_000, 15_000]
    assert sum(out) == 16_000


def test_allocate_splits_equal_large_deps_evenly():
    assert _allocate([50_000, 50_000], 16_000) == [8_000, 8_000]


def test_allocate_empty_is_empty():
    assert _allocate([], 16_000) == []


def test_truncate_head_tail_keeps_both_ends():
    content = "HEAD起始" + ("x" * 5_000) + "TAIL尾注金额￥999"
    out = _truncate_head_tail(content, 1_000)
    assert out.startswith("HEAD起始")  # head kept
    assert "TAIL尾注金额￥999" in out  # tail kept — the fidelity fix (was dropped before)
    assert "中间省略" in out  # and the middle was elided
    assert len(out) <= 1_000  # never exceeds the allowance


def test_truncate_head_tail_short_content_unchanged():
    assert _truncate_head_tail("short", 1_000) == "short"


async def test_long_upstream_injected_with_head_and_tail_preserved():
    # The fix end-to-end: a long upstream product (over budget) reaches the
    # downstream writer with BOTH ends — the old 4000 head-only cap silently dropped
    # the tail (where 金额 / 法条编号 often live).
    long_upstream = "起始结论" + ("数" * (DEP_CONTEXT_BUDGET + 5_000)) + "关键尾注:法条第42条"
    tasks = [
        {"id": "s1", "role": "研究员", "task": "调研"},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    plan, _ = build_run_plan(tasks, id_prefix="t")
    provider = _ContentProvider([long_upstream, "FINAL"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    downstream_user = provider.user_messages[1]
    assert "起始结论" in downstream_user  # head preserved
    assert "关键尾注:法条第42条" in downstream_user  # tail preserved (the fix)
    assert "中间省略" in downstream_user  # it WAS trimmed, not shipped whole


async def test_summarize_dep_is_compressed_not_passed_through():
    # A dep that declared result_handling="summarize" is digested, not budget-passed:
    # the full content must NOT reach the downstream prompt.
    long_upstream = "S摘要起点" + ("数" * 3_000)
    tasks = [
        {"id": "s1", "role": "研究员", "task": "调研", "result_handling": "summarize"},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    plan, _ = build_run_plan(tasks, id_prefix="t")
    provider = _ContentProvider([long_upstream, "FINAL"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    downstream_user = provider.user_messages[1]
    assert "摘要起点" in downstream_user  # the head digest is present
    assert long_upstream not in downstream_user  # but not the full 3000-char product


async def test_wide_fanin_shares_budget_bounded_total():
    # Three long upstreams fanning into one writer share the budget (≈ budget/3 each,
    # water-filled), so the total injected upstream context stays bounded instead of
    # multiplying to 3× a per-dep cap.
    big = "甲" * 40_000
    tasks = [
        {"id": "r1", "role": "调研A", "task": "查A"},
        {"id": "r2", "role": "调研B", "task": "查B"},
        {"id": "r3", "role": "调研C", "task": "查C"},
        {"id": "w", "role": "写手", "task": "汇总", "depends_on": ["r1", "r2", "r3"]},
    ]
    plan, _ = build_run_plan(tasks, id_prefix="t")
    provider = _ContentProvider([big, big, big, "FINAL"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    writer_user = provider.user_messages[3]
    # The three "## 前置结果" blocks together stay within the shared budget (+ markers /
    # labels slack), nowhere near 3 × 40_000. Count the block HEADER ("## 前置结果"), not
    # the bare phrase — the team-position block (D) also names 「前置结果」 when telling a
    # terminal node where its upstream products are.
    assert writer_user.count("## 前置结果") == 3
    assert len(writer_user) < DEP_CONTEXT_BUDGET + 2_000


# --- 递指针不递全文: a file-producing dep is injected as a POINTER, not full text --
#
# When an upstream WROTE its product to the shared workspace (files_touched), the
# downstream gets a tight digest + the artifact paths to file_read — the artifact is
# on disk, so re-shipping it whole through the prompt wastes tokens / risks tail
# trimming. Pure-prose deps (no file to point at) keep the full-text budgeted path.


def _state(content: str = "", *, files: list[str] | None = None) -> RunState:
    return RunState(
        phase=RunPhase.COMPLETED, content=content, files_touched=list(files or [])
    )


def _plan(*specs: RunSpec) -> RunPlan:
    plan = RunPlan()
    for spec in specs:
        plan.add(spec)
    return plan


def test_dep_block_file_writer_becomes_pointer():
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="构建器", task="生成数据"))
    completed = {
        "u": _state("已生成数据集，详见文件。", files=["data/out.csv", "data/schema.json"])
    }
    blocks = _dep_context_blocks(plan, ["u"], completed)
    assert len(blocks) == 1
    block = blocks[0]
    assert block.channel == "dependency"
    assert block.source_role == "构建器"
    assert block.source_run_id == "u"
    assert block.fidelity == "pointer"  # file-writer → pointer fidelity
    body = block.body
    assert "已生成数据集" in body  # the worker's prose handoff digest is kept
    assert "data/out.csv" in body and "data/schema.json" in body  # the pointer
    assert "file_read" in body  # told how to pull the full content
    assert block.files == ["data/out.csv", "data/schema.json"]  # artifact paths carried


def test_dep_pointer_digests_prose_instead_of_shipping_whole():
    # A file-writer with a huge prose body is DIGESTED (not budget-passed whole):
    # the artifact is on disk, the prompt only needs orientation + the path.
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="写手", task="写报告"))
    huge = "开头摘要" + ("文" * 5_000)
    blocks = _dep_context_blocks(plan, ["u"], {"u": _state(huge, files=["report.md"])})
    body = blocks[0].body
    assert "开头摘要" in body  # head digest present
    assert huge not in body  # but NOT the full 5000-char product
    assert "report.md" in body


def test_dep_pointer_caps_file_list_with_elision():
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="生成器", task="批量生成"))
    files = [f"f{i}.txt" for i in range(30)]
    body = _dep_context_blocks(plan, ["u"], {"u": _state("done", files=files)})[0].body
    assert "f0.txt" in body  # the first ones are listed
    assert "f25.txt" not in body  # beyond DEP_POINTER_MAX_FILES (20) is elided
    assert "共 30 个文件" in body  # and the full count is disclosed


def test_dep_block_prose_dep_unchanged_full_text():
    # No files → the existing full-text path: a short prose dep is passed through whole.
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="研究员", task="调研"))
    block = _dep_context_blocks(plan, ["u"], {"u": _state("纯文字结论无文件")})[0]
    assert block.body == "纯文字结论无文件"
    assert block.fidelity == "pass_through"  # no files → prose pass_through
    assert block.truncated is False  # short prose fits the budget whole


async def test_dag_file_writing_upstream_passes_pointer_downstream():
    # End-to-end: the upstream WRITES a file; the downstream's opening prompt carries
    # a pointer (path + file_read hint), proving files_touched flows RunState→prompt.
    tasks = [
        {"id": "s1", "role": "构建器", "task": "生成数据文件"},
        {"id": "s2", "role": "分析师", "task": "分析数据", "depends_on": ["s1"]},
    ]
    plan, _ = build_run_plan(tasks, id_prefix="t")
    reg = ToolRegistry()
    reg.register(_FileWriteTool())
    rounds = [
        # s1 round 1: write the file; round 2: a short prose handoff
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="c1",
                        function_name="file_write",
                        arguments_delta='{"path": "data/out.csv", "content": "a,b\\n1,2"}',
                    )
                ]
            )
        ],
        [LLMChunk(delta_content="已生成 data/out.csv")],
        # s2: final answer (single round)
        [LLMChunk(delta_content="分析完成")],
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
    assert res["t_s1"].files_touched == ["data/out.csv"]
    assert res["t_s2"].phase is RunPhase.COMPLETED
    downstream_user = provider.user_messages[-1]  # the analyst's opening prompt
    assert "data/out.csv" in downstream_user  # got the pointer
    assert "file_read" in downstream_user


# --- 工作区产物清单: peer products (attributed) + pre-existing files -------------


def test_workspace_manifest_lists_nondep_teammate_files():
    plan = _plan(
        RunSpec(run_id="a", agent_id="a", role="队友A", task="x"),
        RunSpec(run_id="b", agent_id="b", role="队友B", task="y"),
    )
    completed = {"a": _state(files=["a.py"]), "b": _state(files=["b.py"])}
    # The worker depends on "a" (excluded — it gets the richer pointer block); the
    # non-dep peer "b" is surfaced so its product is discoverable.
    manifest = _workspace_manifest(plan, completed, [], exclude_runs={"a"})
    assert "b.py" in manifest and "队友B" in manifest
    assert "a.py" not in manifest  # the dep is not duplicated here


def test_workspace_manifest_lists_preexisting_files():
    plan = _plan(RunSpec(run_id="a", agent_id="a", role="队友A", task="x"))
    # No peer products; the ambient index (uploads / prior turns) is surfaced.
    manifest = _workspace_manifest(plan, {}, ["上传/data.csv", "spec.md"], exclude_runs=set())
    assert "上传/data.csv" in manifest and "spec.md" in manifest
    assert "工作区已有" in manifest


def test_workspace_manifest_dedupes_dep_and_peer_files_from_index():
    plan = _plan(
        RunSpec(run_id="dep", agent_id="dep", role="前置", task="x"),
        RunSpec(run_id="peer", agent_id="peer", role="队友", task="y"),
    )
    completed = {"dep": _state(files=["dep.py"]), "peer": _state(files=["peer.py"])}
    # The index also lists dep.py + peer.py (they're on disk) plus an ambient file.
    manifest = _workspace_manifest(
        plan, completed, ["dep.py", "peer.py", "ambient.txt"], exclude_runs={"dep"}
    )
    # dep file stays out entirely (it has the pointer block); peer file is attributed,
    # not re-listed as「工作区已有」; the genuinely ambient file is labeled as such.
    assert "dep.py" not in manifest
    assert manifest.count("peer.py") == 1 and "队友" in manifest
    assert "ambient.txt（工作区已有）" in manifest


def test_workspace_manifest_empty_when_nothing_to_surface():
    plan = _plan(RunSpec(run_id="a", agent_id="a", role="队友A", task="x"))
    # Only files belong to a dep (excluded) and nothing in the index → empty.
    assert _workspace_manifest(plan, {"a": _state(files=["a.py"])}, [], exclude_runs={"a"}) == ""
    # A teammate that wrote nothing + no index contributes nothing.
    assert _workspace_manifest(plan, {"a": _state("仅文字")}, [], exclude_runs=set()) == ""


def test_workspace_manifest_caps_total_files():
    specs = [RunSpec(run_id=f"r{i}", agent_id=f"r{i}", role=f"R{i}", task="t") for i in range(60)]
    plan = _plan(*specs)
    completed = {f"r{i}": _state(files=[f"r{i}.txt"]) for i in range(60)}
    # 60 peer files + 60 ambient files: the count cap binds (short paths stay well under
    # the char budget) → exactly WORKSPACE_MANIFEST_MAX_FILES entries + one elision line.
    index = [f"amb{i}.txt" for i in range(60)]
    manifest = _workspace_manifest(plan, completed, index, exclude_runs=set())
    entries = [ln for ln in manifest.splitlines() if ln.startswith("- ")]
    assert len(entries) == 40  # WORKSPACE_MANIFEST_MAX_FILES
    assert manifest.splitlines()[-1].startswith("……")  # more-remain elision marker


def test_workspace_manifest_char_budget_binds_before_count():
    # A few very long paths blow the char budget before the 40-file count cap — the
    # budget must bind first so long paths can't bloat the prompt.
    plan = _plan(RunSpec(run_id="a", agent_id="a", role="A", task="t"))
    long_paths = [f"deeply/nested/dir/segment/{i}/" + ("x" * 200) + ".txt" for i in range(40)]
    manifest = _workspace_manifest(plan, {}, long_paths, exclude_runs=set())
    entries = [ln for ln in manifest.splitlines() if ln.startswith("- ")]
    assert 0 < len(entries) < 40  # stopped by the char budget, not the count cap
    assert len(manifest) <= 2200  # ~CHAR_BUDGET + the elision line, not 40×200
    assert manifest.splitlines()[-1].startswith("……")


def test_build_messages_injects_workspace_manifest():
    plan = _plan(
        RunSpec(run_id="me", agent_id="me", role="我", task="干活", depends_on=["dep"]),
        RunSpec(run_id="dep", agent_id="dep", role="前置", task="前置"),
        RunSpec(run_id="peer", agent_id="peer", role="并行队友", task="别的"),
    )
    completed = {
        "dep": _state("前置产物"),
        "peer": _state(files=["peer/out.json"]),
    }
    msgs = _build_messages(
        plan, plan.by_id("me"), completed, "SYS", "原始请求", index_paths=["上传/raw.txt"]
    )
    user = msgs[1].content or ""
    assert "工作区现有文件" in user
    assert "peer/out.json" in user and "并行队友" in user  # peer product, attributed
    assert "上传/raw.txt" in user  # pre-existing file from the index


def test_build_messages_no_manifest_block_when_nothing_ambient():
    plan = _plan(RunSpec(run_id="me", agent_id="me", role="我", task="干活"))
    msgs = _build_messages(plan, plan.by_id("me"), {}, "SYS", "原始请求")
    assert "工作区现有文件" not in (msgs[1].content or "")


async def test_safe_index_files_swallows_backend_failure():
    class _Boom:
        async def index_files(self, **_kw):
            raise RuntimeError("desktop dropped")

    class _Ok:
        def __init__(self) -> None:
            self.order: str | None = None

        async def index_files(self, *, order: str = "path"):
            self.order = order
            return (["a.txt", "b.txt"], True)

    assert await _safe_index_files(_Boom()) == []  # failure → empty, never raises
    assert await _safe_index_files(object()) == []  # backend without indexing → empty
    ok = _Ok()
    assert await _safe_index_files(ok) == ["a.txt", "b.txt"]  # paths, flag dropped
    assert ok.order == "recent"  # manifest asks for newest-first relevance ordering


class _CountingIndexBackend:
    """Wraps a real backend but counts ``index_files`` calls (delegates everything
    else), to prove the pre-existing-files walk is snapshotted once per batch."""

    def __init__(self, inner: object) -> None:
        self._inner = inner
        self.index_calls = 0

    async def index_files(self, cap: int | None = None, *, order: str = "path"):
        self.index_calls += 1
        return await self._inner.index_files(cap, order=order)

    def __getattr__(self, name: str):
        return getattr(self._inner, name)


async def test_preexisting_index_snapshotted_once_per_turn():
    # Three workers in one batch share a SINGLE workspace index walk (the per-turn
    # snapshot cache), not one walk per worker — so the mtime stat cost doesn't multiply.
    backend = _CountingIndexBackend(
        ServerWorkspace(root=_WS_ROOT, sandbox=SubprocessSandbox())
    )
    ctx = ToolContext(
        execution_id="e", run_id="s", agent_id="a", backend=backend, user_id="u"
    )
    plan, _ = build_run_plan(
        [
            {"role": "A", "task": "a"},
            {"role": "B", "task": "b"},
            {"role": "C", "task": "c"},
        ],
        id_prefix="t",
    )
    provider = _ContentProvider(["A", "B", "C"])
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=ctx,
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    await WaveScheduler().run(plan, executor)
    assert backend.index_calls == 1  # one walk for the whole batch, not three


# --- 并行写软约束: the sibling block warns peers off colliding file paths --------


def test_sibling_block_warns_about_file_path_collisions():
    spec = RunSpec(run_id="x", agent_id="x", role="A", task="t", sibling_summary="- B：做B")
    msgs = _build_messages(_plan(spec), spec, {}, "SYS", "原始请求")
    user = msgs[1].content or ""
    assert "避免互相覆盖" in user  # the soft path-ownership nudge
    assert "做B" in user  # still carries the sibling intent summary


def test_team_position_block_four_dag_shapes():
    # D（统一团队位置块）: a worker's user prompt now carries its DAG TOPOLOGY — who runs
    # beside it (siblings) and, crucially, where its output GOES — symmetric to the
    # upstream PRODUCT injection (_dep_context_blocks). Four shapes → four framings; this
    # pins each so the「上游越权写最终交付物」fix (an upstream link learns it hands off,
    # not authors the final artifact) and the terminal-ownership boost (a writer learns
    # it IS the final author) can't silently regress. Also pins A1 (递指针 affordance):
    # the upstream branch — and ONLY it — grants a permission-style, role-suffixed
    # filename for persisting large intermediates, replacing the residual empty-path
    # file_write; the terminal author names the final file itself, so it must NOT appear
    # there or on a pure parallel/solo node.
    plan, errs = build_run_plan(
        [
            {"id": "r1", "role": "调研员A", "task": "查A"},
            {"id": "r2", "role": "调研员B", "task": "查B"},
            {"id": "w", "role": "写手", "task": "写报告", "depends_on": ["r1", "r2"]},
        ],
        id_prefix="t",
    )
    assert errs == []
    r1, w = plan.by_id("t_r1"), plan.by_id("t_w")

    # (1) UPSTREAM link (has dependents): told it feeds the downstream 写手 and must NOT
    #     produce the final artifact itself — the over-reach fix.
    up = _build_messages(plan, r1, {}, "SYS", "原始请求")[1].content or ""
    assert "你在团队中的位置" in up
    assert "上游一环" in up and "写手" in up
    assert "不要自己产出整个最终交付物" in up
    assert "调研员B" in up  # parallel-peer awareness still present
    assert "不一定全是你的活" in up  # request reframed as a team goal, not a mandate
    # A1: an upstream link that wants to persist a large intermediate is told to give it a
    # role-suffixed filename (no empty-path file_write) — only on this branch.
    assert "findings-" in up and "切勿用空路径" in up

    # (2) TERMINAL synthesizer (has upstream, no dependents): told it IS the final author
    #     — reinforces structure ownership (the worker-side L3 lever).
    term = _build_messages(plan, w, {}, "SYS", "原始请求")[1].content or ""
    assert "终端环" in term and "最终交付物" in term
    assert "不要自己产出整个最终交付物" not in term  # not an upstream link
    assert "findings-" not in term  # A1 is upstream-only; the terminal author names the final file
    assert w.sibling_summary == ""  # lone fan-in → no parallel-peer line

    # (3) PARALLEL batch (siblings only, no up/down): peer coordination, no flow framing.
    par_plan, _ = build_run_plan(
        [{"role": "A", "task": "做A"}, {"role": "B", "task": "做B"}], id_prefix="p"
    )
    par = _build_messages(par_plan, par_plan.by_id("p_1"), {}, "SYS", "原始请求")[1].content or ""
    assert "并行队友" in par
    assert "上游一环" not in par and "终端环" not in par
    assert "findings-" not in par  # no hand-off → no A1 intermediate-persist hint

    # (4) SOLO single worker (no team): no position block, plain request header.
    solo_plan, _ = build_run_plan([{"role": "A", "task": "做A"}], id_prefix="s")
    solo = _build_messages(solo_plan, solo_plan.by_id("s_1"), {}, "SYS", "原始请求")[1].content or ""
    assert "你在团队中的位置" not in solo
    assert "不一定全是你的活" not in solo  # a solo worker IS the whole job
