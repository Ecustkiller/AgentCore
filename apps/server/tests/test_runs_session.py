"""RunSession capture + continue_run (统一「续干」原语).

Proves a finished worker is kept alive as a recoverable RunSession and that
``continue_run`` recalls the SAME author: it sees its prior transcript + the
appended instruction, extends the transcript, and emits continuation graph
events with ``continues_run_id`` = session root and ``parent_run_id`` = true parent.
"""

from pathlib import Path

from agentcore.llm.provider.protocol import LLMChunk
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs import (
    RunPhase,
    RunSession,
    RunSpec,
    build_agent_executor,
    build_run_plan,
    continue_run,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.sessions import SessionStore
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _ContentProvider:
    """Fake LLM: one scripted content chunk per call; records full requests."""

    def __init__(self, contents: list[str]) -> None:
        self._contents = contents
        self.calls = 0
        self.requests: list[list[tuple[str, str]]] = []

    async def stream(self, request):
        self.requests.append([(m.role, m.content or "") for m in request.messages])
        text = self._contents[self.calls] if self.calls < len(self._contents) else "done"
        self.calls += 1
        yield LLMChunk(delta_content=text)


def _ctx() -> ToolContext:
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


async def _make_session(provider: _ContentProvider, *, run_id: str = "t_1") -> RunSession:
    """Run one worker through the executor and snapshot it as a RunSession."""
    from agentcore.runtime.runs import WaveScheduler

    plan, _ = build_run_plan(
        [{"role": "A", "task": "做A"}], id_prefix="t", parent_run_id="CEO"
    )
    res = await WaveScheduler().run(plan, _executor(plan, provider, EventSink()))
    state = res[run_id]
    return RunSession(
        run_id=run_id,
        spec=plan.by_id(run_id),
        transcript=state.transcript,
        content=state.content,
    )


def test_session_store_put_get_and_miss():
    store = SessionStore()
    assert store.get("nope") is None
    assert "nope" not in store
    spec = RunSpec(run_id="r1", agent_id="r1", role="A", task="t")
    sess = RunSession(run_id="r1", spec=spec, transcript=[], content="x")
    store.put(sess)
    assert store.get("r1") is sess
    assert "r1" in store
    assert len(store) == 1


async def test_continue_run_revises_from_transcript_and_extends_it():
    provider = _ContentProvider(["第一版", "修订版"])
    session = await _make_session(provider)
    original_len = len(session.transcript)

    state = await continue_run(
        session=session,
        feedback="把语气改正式",
        continuation_run_id="t_1_rev1",
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        execution_id="e",
    )

    assert state.phase is RunPhase.COMPLETED
    assert state.content == "修订版"
    rev_request = provider.requests[-1]
    assert any(role == "assistant" and content == "第一版" for role, content in rev_request)
    assert any(role == "user" and "把语气改正式" in content for role, content in rev_request)
    assert len(state.transcript) > original_len
    assert state.transcript[-1].role == "assistant"
    assert state.transcript[-1].content == "修订版"


async def test_continue_run_does_not_mutate_stored_transcript_until_committed():
    provider = _ContentProvider(["第一版", "修订版"])
    session = await _make_session(provider)
    before = list(session.transcript)
    await continue_run(
        session=session,
        feedback="改",
        continuation_run_id="t_1_rev1",
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        execution_id="e",
    )
    assert session.transcript == before


async def test_continue_run_emits_continues_run_id_and_true_parent():
    provider = _ContentProvider(["第一版", "修订版"])
    session = await _make_session(provider)
    sink = EventSink()
    await continue_run(
        session=session,
        feedback="改",
        continuation_run_id="t_1_rev1",
        llm=provider,
        tools=ToolRegistry(),
        sink=sink,
        base_tool_context=_ctx(),
        execution_id="e",
        parent_run_id="CEO",
    )
    sink.close()
    events = [e async for e in sink]
    started = [e for e in events if e.type == EventType.RUN_STARTED]
    assert len(started) == 1
    assert started[0].payload["run_id"] == "t_1_rev1"
    assert started[0].payload["continues_run_id"] == "t_1"
    assert started[0].payload["parent_run_id"] == "CEO"
    assert "revision" not in started[0].payload
    completed = [e for e in events if e.type == EventType.RUN_COMPLETED]
    assert completed and completed[0].payload["run_id"] == "t_1_rev1"
    assert completed[0].payload["role"] == "member"


async def test_continue_run_failure_returns_failed_state():
    provider = _ContentProvider(["第一版"])
    session = await _make_session(provider)

    class _Boom:
        async def stream(self, request):
            raise RuntimeError("provider down")
            yield  # pragma: no cover - async generator

    sink = EventSink()
    state = await continue_run(
        session=session,
        feedback="改",
        continuation_run_id="t_1_rev1",
        llm=_Boom(),
        tools=ToolRegistry(),
        sink=sink,
        base_tool_context=_ctx(),
        execution_id="e",
    )
    assert state.phase is RunPhase.FAILED
    assert "provider down" in state.error
    sink.close()
    assert EventType.RUN_FAILED in [e.type async for e in sink]
