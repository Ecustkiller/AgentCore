from dataclasses import replace

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.protocol import LLMChunk, ToolCallDelta
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.executor import build_agent_executor
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec
from agentcore.runtime.runs.wave import WaveScheduler
from agentcore.tools.builtin.escalate import EscalateTool
from agentcore.tools.protocol import ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

from tests.runs_executor.conftest import (
    _ContentProvider,
    _ScriptedRounds,
    _ctx,
    _executor,
)


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


async def test_worker_escalation_emits_live_event_before_completion():
    # 升级实时可见: the executor wires the worker's escalate to a run-scoped RUN_ESCALATION
    # so the team UI surfaces it the INSTANT it is raised — well before the worker's node
    # completes (ordering proves "live", not a post-hoc harvest at run end).
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
    sink = EventSink()
    executor = build_agent_executor(
        plan=plan,
        llm=_ScriptedRounds(rounds),
        tools=reg,
        sink=sink,
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    await WaveScheduler().run(plan, executor)
    sink.close()
    events = [e async for e in sink]
    types = [e.type for e in events]
    assert EventType.RUN_ESCALATION in types
    esc = next(e for e in events if e.type == EventType.RUN_ESCALATION)
    assert esc.payload["run_id"] == "t_1"
    assert esc.payload["question"] == "用 Postgres 还是 MySQL?"
    assert esc.payload["assumption"] == "暂用 Postgres"
    assert esc.payload["blocking"] is True
    # Live, not a harvest: the escalation surfaces strictly before the run finishes.
    assert types.index(EventType.RUN_ESCALATION) < types.index(EventType.RUN_COMPLETED)


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


async def test_escalate_invokes_on_escalate_callback_with_triple():
    # 升级实时可见: the tool hands the executor-provided live channel its (question,
    # assumption, blocking) triple. An empty question is rejected BEFORE any emit.
    tool = EscalateTool()
    seen: list[tuple[str, str, bool]] = []
    ctx = replace(_ctx(), on_escalate=lambda q, a, b: seen.append((q, a, b)))
    await tool.execute({"question": "  "}, ctx)
    assert seen == []  # rejected first, nothing surfaced
    await tool.execute({"question": "Q?", "assumption": "暂定 A", "blocking": True}, ctx)
    assert seen == [("Q?", "暂定 A", True)]


async def test_escalate_callback_failure_is_non_fatal():
    # The durable path (transcript → RunState.escalations) is unconditional, so a live-emit
    # hiccup must never sink the escalation or the worker — the tool still ACKs CONTINUE.
    def _boom(_q: str, _a: str, _b: bool) -> None:
        raise RuntimeError("sink closed")

    ctx = replace(_ctx(), on_escalate=_boom)
    ok = await EscalateTool().execute({"question": "Q?"}, ctx)
    assert ok.success is True and ok.is_terminal is False
