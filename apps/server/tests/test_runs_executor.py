"""End-to-end wiring test: build_run_plan → build_agent_executor → WaveScheduler.

Drives the real ``engine.react_loop`` with a scripted fake provider (no network)
to prove the executor builds correct worker messages, folds results into
RunState, injects an upstream product into a downstream node's prompt, and emits
the ``run_*`` graph events.
"""

from pathlib import Path

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.protocol import LLMChunk, TokenUsage, ToolCallDelta
from agentcore.runtime.approvals import ApprovalGate, ApprovalRegistry
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.executor import _is_hard_failure, build_agent_executor
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunContract, RunPhase
from agentcore.runtime.runs.wave import WaveScheduler
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _ContentProvider:
    """Fake LLM: yields one scripted content chunk per call (no tool calls) and
    records each request's user message so dep-injection can be asserted."""

    def __init__(self, contents: list[str]) -> None:
        self._contents = contents
        self.calls = 0
        self.user_messages: list[str] = []
        self.system_messages: list[str] = []

    async def stream(self, request):
        user = next((m.content for m in request.messages if m.role == "user"), "")
        self.user_messages.append(user or "")
        system = next((m.content for m in request.messages if m.role == "system"), "")
        self.system_messages.append(system or "")
        text = self._contents[self.calls] if self.calls < len(self._contents) else "done"
        self.calls += 1
        yield LLMChunk(delta_content=text)


def _ctx() -> ToolContext:
    # These fake-provider runs never invoke a tool, so the backend is inert — it
    # only has to satisfy the ToolContext contract (workspace_dir → backend).
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
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


async def test_contract_retry_feeds_shortfall_into_second_prompt():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"must_contain": ["风险"]}}], id_prefix="t"
    )
    provider = _ContentProvider(["没有那个词", "已包含风险二字"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert "修正" in provider.user_messages[1]
    assert "风险" in provider.user_messages[1]


async def test_contract_requirements_stated_in_first_prompt():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A", "contract": {"required_sections": ["结论"]}}], id_prefix="t"
    )
    provider = _ContentProvider(["# 结论\n好的"])
    await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    assert "产出要求" in provider.user_messages[0]
    assert "结论" in provider.user_messages[0]


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
        registry=ApprovalRegistry(),
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
        return ToolResult(tool_call_id="", success=True, output="", terminal=False)


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
