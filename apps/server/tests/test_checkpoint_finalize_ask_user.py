"""挂起即收口 (②): the ask_user 收口 backend slice.

Pins the finalize-at-pause behavior that collapses the live/durable dual-state. A
blocking ``ask_user`` PERSISTS its durable frame and then ENDS the turn
(``FinishReason.PAUSED``) instead of parking on the in-memory interaction Future — so
EVERY resolution (even in-session) flows through the one cold ``POST .../resume`` path.
A pause whose frame could NOT be saved falls back to the in-memory blocking suspend
(§六-1 narrow fallback), asserted here as the negative case.

Three layers:
- the tool: returns SUSPEND only when the flag is ON AND a resumable frame ACTUALLY
  saved; otherwise it falls through to the in-memory wait (never finalize a turn it
  could not later resume).
- the engine: a SUSPEND terminal ends the loop on PAUSED, leaving the call PENDING (no
  tool message, no §8.3 tool_call fact) so ``window_from_journal`` folds back to a
  transcript ending at the assistant — the exact resume-window source the blocking
  pause produced.
- the persist tail: PAUSED parks the turn (no assistant row / cost / metrics written —
  the frame is the record until resume).
"""

from pathlib import Path

from agentcore.core.types import ToolEffect
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import EventSink, EventType, FinishReason, SSEEvent
from agentcore.runtime.facts import FactKind, TurnFactLog, TurnStartedFact, current_fact_log
from agentcore.runtime.journal import runs_from_entries, window_from_journal
from agentcore.runtime.suspension import captain_transcript
from agentcore.tools.builtin.ask_user import AskUserTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _ScriptedProvider:
    """Yields one pre-scripted chunk list per ``stream`` call (one call per round)."""

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _ExplodingBridge:
    """A ClientRequestBridge whose ``suspend`` must NEVER be reached on the finalize path.

    The whole point of 挂起即收口 is that the turn ends in place — no in-memory Future. If
    the loop ever parks on this bridge, the test fails loudly instead of hanging.
    """

    async def suspend(self, *args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("finalize path must not touch the suspend bridge")


class _RecordingBridge:
    """A bridge that counts ``suspend`` calls and settles immediately (blocking path)."""

    def __init__(self, decision: CheckpointDecision = CheckpointDecision.CONTINUE) -> None:
        self._decision = decision
        self.suspend_calls = 0

    async def suspend(self, request_id, conversation_id, *, kind, payload, timeout, on_suspended):  # noqa: ANN001
        self.suspend_calls += 1
        on_suspended()
        return CheckpointResponse(decision=self._decision, note="", selected=[])


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="cap",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        conversation_id="c1",
    )


def _ask_tool(bridge, saver, deleter, sink: EventSink) -> AskUserTool:
    """A fully-wired live-CEO ask_user (the only construction that can persist a frame)."""
    return AskUserTool(
        sink=sink,
        conversation_id="c1",
        registry=bridge,  # type: ignore[arg-type]
        timeout_seconds=1.0,
        captain_run_id="cap",
        base_system_prompt="你是 CEO。",
        user_message="A 还是 B?",
        message_id="m1",
        suspension_saver=saver,
        suspension_deleter=deleter,
    )


def _drain(sink: EventSink) -> list[SSEEvent]:
    out: list[SSEEvent] = []
    while not sink._queue.empty():  # noqa: SLF001 - test-only inspection
        out.append(sink._queue.get_nowait())
    return out


# --- the tool: finalize only when ON and a frame actually saved --------------------


async def test_finalize_returns_suspend_and_skips_the_wait():
    # A resumable frame saved (transcript published) ⇒ the tool ends the turn in place: a
    # SUSPEND result, the durable frame persisted, the card surfaced, and the in-memory
    # Future NEVER touched.
    bridge = _RecordingBridge()
    frames: list = []

    async def saver(frame) -> None:  # noqa: ANN001 - TurnSuspension
        frames.append(frame)

    async def deleter(_message_id: str) -> None:
        return None

    sink = EventSink()
    tool = _ask_tool(bridge, saver, deleter, sink)
    token = captain_transcript.set([LLMMessage(role="user", content="A 还是 B?")])
    try:
        res = await tool.execute({"message": "A 还是 B?"}, _ctx())
    finally:
        captain_transcript.reset(token)

    assert res.effect is ToolEffect.SUSPEND
    assert res.is_terminal is True
    assert res.final_text is None  # no answer produced — the turn awaits /resume
    assert bridge.suspend_calls == 0  # never parked on the Future
    assert len(frames) == 1  # the durable resume frame was saved
    # The card surfaced so the client can render the (single) resume prompt.
    assert any(e.type is EventType.CHECKPOINT_REQUIRED for e in _drain(sink))


async def test_finalize_falls_back_to_wait_when_frame_not_saved():
    # The frame could NOT be captured (no captain_transcript published) ⇒ the turn would be
    # un-resumable, so the tool MUST fall through to the in-memory wait rather than finalize
    # and silently strand it (§六-1 narrow live fallback).
    bridge = _RecordingBridge()
    frames: list = []

    async def saver(frame) -> None:  # noqa: ANN001
        frames.append(frame)

    async def deleter(_message_id: str) -> None:
        return None

    tool = _ask_tool(bridge, saver, deleter, EventSink())
    # NB: no captain_transcript.set(...) — persist_suspension returns False (nothing to
    # capture), so finalize is declined.
    res = await tool.execute({"message": "A 还是 B?"}, _ctx())

    assert frames == []  # nothing saved
    assert bridge.suspend_calls == 1  # parked on the Future (the blocking path)
    assert res.effect is not ToolEffect.SUSPEND


# --- the engine: a SUSPEND terminal ends the loop on PAUSED, call left pending ------


async def test_loop_finalizes_ask_user_to_paused():
    # Drive the REAL captain loop with the REAL AskUserTool. The loop must end on
    # FinishReason.PAUSED with the suspended call PENDING — and the journal the face persisted
    # must fold back to the transcript ending at the assistant (the resume window source),
    # byte-for-byte the same shape the blocking pause produces.
    system_prompt = "你是 CEO。"
    user_message = "A 还是 B?"
    captured: dict[str, object] = {}

    async def saver(frame) -> None:  # noqa: ANN001 - TurnSuspension
        captured["transcript"] = list(frame.transcript)
        captured["journal_entries"] = list(frame.journal_entries)

    async def deleter(_message_id: str) -> None:
        captured["deleted"] = True

    sink = EventSink()
    ask_tool = AskUserTool(
        sink=sink,
        conversation_id="c1",
        registry=_ExplodingBridge(),  # type: ignore[arg-type]
        timeout_seconds=1.0,
        captain_run_id="cap",
        base_system_prompt=system_prompt,
        user_message=user_message,
        message_id="m1",
        suspension_saver=saver,
        suspension_deleter=deleter,
    )
    reg = ToolRegistry()
    reg.register(ask_tool)

    provider = _ScriptedProvider(
        [
            [
                LLMChunk(
                    delta_tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_ask",
                            function_name="ask_user",
                            arguments_delta=f'{{"message": "{user_message}"}}',
                        )
                    ]
                )
            ]
        ]
    )

    messages = [
        LLMMessage(role="system", content=system_prompt),
        LLMMessage(role="user", content=user_message),
    ]
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=5)
    log = TurnFactLog()
    log.record_fact(
        TurnStartedFact(
            system_prompt=system_prompt, user_message=user_message, model_profile="m"
        ).to_fact()
    )
    finish_override: list[FinishReason] = []
    fl_token = current_fact_log.set(log)
    ct_token = captain_transcript.set(messages)
    try:
        content, _reasoning, _usage, _rounds = await react_loop(
            messages=messages,
            llm=provider,
            tools=reg,
            sink=sink,
            tool_context=_ctx(),
            profile=profile,
            finish_override_sink=finish_override,
            run_id="cap",
            role="captain",
        )
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(fl_token)

    # The loop ended ON PAUSED — the single signal the pipeline maps to a paused
    # message_end + a parked persist tail. No answer text was produced.
    assert finish_override == [FinishReason.PAUSED]
    assert content == ""

    # The suspended call is pending: the live transcript ends at the assistant issuing
    # ask_user, with NO tool result message (the bridge was never touched).
    assert [m.role for m in messages] == ["system", "user", "assistant"]
    assert messages[-1].tool_calls[0].function.name == "ask_user"
    assert all(m.role != "tool" for m in messages)

    # No §8.3 tool_call fact for the suspended call (recording one would inject a phantom
    # result into the resumed window).
    assert all(f["kind"] != FactKind.TOOL_CALL for f in log.entries())

    # THE GOLDEN: the window folded from the PERSISTED journal == the snapshotted transcript
    # == the live transcript — so a cold resume rebuilds the exact pre-pause window.
    persisted = captured["journal_entries"]  # type: ignore[assignment]
    assert window_from_journal(persisted) == captured["transcript"]
    assert window_from_journal(persisted) == messages

    # DISPLAY whole: the richer execution stream still surfaces the checkpoint card.
    runs = runs_from_entries(persisted)
    assert runs is not None
    assert any(e["type"] == "checkpoint_required" for e in runs["events"])


# --- the persist tail: PAUSED parks the turn (writes nothing) -----------------------


async def test_persist_tail_parks_on_paused(monkeypatch):
    # A PAUSED result must return BEFORE any DB access: writing an assistant row / journal /
    # cost / metrics here would create a phantom completed reply and double-count on resume.
    from agentcore.conversation import turn_persistence

    def _bomb(*_args, **_kwargs):
        raise AssertionError("a paused turn must not touch the DB")

    monkeypatch.setattr(turn_persistence, "async_session_factory", _bomb)

    # Returns cleanly (parks) without ever opening a session.
    await turn_persistence.persist_turn_result(
        result={"message_id": "m1", "finish_reason": FinishReason.PAUSED, "content": ""},
        conversation_id="c1",
        user_id="u1",
        folder_id=None,
        backend=object(),  # type: ignore[arg-type] - never touched on the parked path
        sink=EventSink(),
        user_message="A 还是 B?",
        generate_title=True,
        llm_credentials=None,
        trace_id="t",
        turn_id="tn",
        duration_ms=1,
    )
