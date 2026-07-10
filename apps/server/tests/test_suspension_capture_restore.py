"""Shared suspension capture skeleton + cloud resume restore ratchet."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.events import FinishReason
from agentcore.runtime.facts import TurnFactLog, TurnStartedFact, current_fact_log
from agentcore.runtime.suspension import AskUserSuspension, captain_transcript
from agentcore.runtime.suspension_capture import SuspensionCapture, persist_suspension_capture
from agentcore.runtime.suspension_persistence import restore_paused_turn


def _ask_user_suspension() -> AskUserSuspension:
    return AskUserSuspension(
        message_id="msg-1",
        conversation_id="conv-1",
        user_id="user-1",
        captain_run_id="run-1",
        checkpoint_id="cp-1",
        tool_call_id="tc-1",
        base_system_prompt="sys",
        user_message="hello",
        question="pick one",
        trace_id="trace-1",
    )


@pytest.mark.asyncio
async def test_persist_suspension_capture_snapshots_fact_log_and_saves() -> None:
    required = SimpleNamespace(
        type=SimpleNamespace(value="checkpoint_required"),
        payload={"checkpoint_id": "cp-1"},
        timestamp="t1",
    )
    transcript = [LLMMessage(role="user", content="hi")]
    # Bind an ambient fact log so the capture snapshots a real §8.3 stream (the 唯一权威载体):
    # the turn_started head + the about-to-emit checkpoint_required card appended as trailing.
    log = TurnFactLog()
    log.record_fact(
        TurnStartedFact(system_prompt="sys", user_message="hi", model_profile="m").to_fact()
    )
    ct_token = captain_transcript.set(transcript)
    fl_token = current_fact_log.set(log)
    saved: list[AskUserSuspension] = []

    def build_frame(capture: SuspensionCapture) -> AskUserSuspension:
        assert capture.transcript == transcript
        # journal_entries is the sole authoritative carrier; the display ``journal`` derives.
        assert capture.journal_entries[0]["kind"] == "turn_started"
        assert capture.journal_entries[-1]["kind"] == "checkpoint_required"
        return AskUserSuspension(
            message_id="msg-1",
            conversation_id="conv-1",
            user_id="user-1",
            captain_run_id="run-1",
            checkpoint_id="cp-1",
            tool_call_id="tc-1",
            base_system_prompt="sys",
            user_message="hello",
            question="q",
            journal_entries=capture.journal_entries,
            transcript=capture.transcript,
            history=capture.history,
            trace_id=capture.trace_id,
        )

    async def saver(frame: AskUserSuspension) -> None:
        saved.append(frame)

    try:
        ok = await persist_suspension_capture(
            checkpoint_id="cp-1",
            required_event=required,
            build_frame=build_frame,
            saver=saver,
        )
    finally:
        current_fact_log.reset(fl_token)
        captain_transcript.reset(ct_token)

    assert ok is True
    assert len(saved) == 1
    # The display resume seed is DERIVED from journal_entries (P0-B Phase 3): the execution
    # turn_started fact drops, the surface checkpoint_required card survives.
    assert [e["type"] for e in saved[0].journal] == ["checkpoint_required"]
    assert saved[0].journal[0]["payload"] == {"checkpoint_id": "cp-1"}


@pytest.mark.asyncio
async def test_persist_suspension_capture_skips_without_transcript() -> None:
    required = SimpleNamespace(
        type=SimpleNamespace(value="checkpoint_required"),
        payload={},
        timestamp=None,
    )
    token = captain_transcript.set(None)
    try:
        ok = await persist_suspension_capture(
            checkpoint_id="cp-1",
            required_event=required,
            build_frame=lambda _c: _ask_user_suspension(),
            saver=AsyncMock(),
        )
    finally:
        captain_transcript.reset(token)
    assert ok is False


@pytest.mark.asyncio
async def test_restore_paused_turn_upserts_frame_without_notify() -> None:
    suspension = _ask_user_suspension()
    with patch(
        "agentcore.runtime.suspension_persistence.async_session_factory"
    ) as factory:
        session = AsyncMock()
        factory.return_value.__aenter__.return_value = session
        with patch(
            "agentcore.runtime.suspension_persistence.PausedTurnRepository"
        ) as repo_cls, patch(
            "agentcore.runtime.suspension_persistence._notify_pause",
            AsyncMock(),
        ) as notify:
            repo_cls.return_value.upsert = AsyncMock()
            await restore_paused_turn(suspension)

    repo_cls.return_value.upsert.assert_awaited_once_with(
        message_id="msg-1",
        conversation_id="conv-1",
        user_id="user-1",
        frame=suspension.to_json(),
        trace_id="trace-1",
    )
    notify.assert_not_awaited()


@pytest.mark.asyncio
async def test_resume_chat_restores_frame_when_pipeline_returns_error() -> None:
    """Cloud resume failure must re-upsert the claimed frame so /resume can retry."""
    from agentcore.conversation import turns as turns_mod
    from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
    from agentcore.runtime.events import EventSink

    suspension = _ask_user_suspension()
    sink = EventSink()
    conv = MagicMock()
    conv.folder_id = None

    with (
        patch.object(turns_mod, "async_session_factory") as factory,
        patch.object(turns_mod, "ConversationRepository") as conv_repo_cls,
        patch.object(turns_mod, "BoardRepository") as board_repo_cls,
        patch.object(turns_mod, "resolve_local_binding", AsyncMock(return_value=None)),
        patch.object(turns_mod, "resolve_profile_set", AsyncMock(return_value=None)),
        patch.object(turns_mod, "load_chat_context", AsyncMock(return_value=[])),
        patch.object(turns_mod, "build_turn_backend", return_value=MagicMock()),
        patch.object(turns_mod, "session_callbacks", return_value=(AsyncMock(), AsyncMock())),
        patch.object(turns_mod, "suspension_callbacks", return_value=(AsyncMock(), AsyncMock())),
        patch.object(turns_mod, "workspace_lock") as lock,
        patch.object(
            turns_mod,
            "resume_chat_pipeline",
            AsyncMock(
                return_value={
                    "message_id": "msg-1",
                    "content": "",
                    "error": "boom",
                    "finish_reason": FinishReason.ERROR,
                    "cost_runs": [],
                }
            ),
        ),
        patch.object(turns_mod, "persist_turn_result", AsyncMock()),
        patch.object(turns_mod, "restore_paused_turn", AsyncMock()) as restore,
    ):
        session = AsyncMock()
        factory.return_value.__aenter__.return_value = session
        conv_repo_cls.return_value.get_by_id_unscoped = AsyncMock(return_value=conv)
        board_repo_cls.return_value.get_by_conversation_id = AsyncMock(return_value=None)
        lock.return_value.__aenter__ = AsyncMock(return_value=None)
        lock.return_value.__aexit__ = AsyncMock(return_value=None)

        await turns_mod.resume_chat(
            suspension=suspension,
            response=CheckpointResponse(decision=CheckpointDecision.CONTINUE),
            sink=sink,
        )

    restore.assert_awaited_once_with(suspension)


@pytest.mark.asyncio
async def test_resume_chat_does_not_restore_on_success() -> None:
    from agentcore.conversation import turns as turns_mod
    from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
    from agentcore.runtime.events import EventSink

    suspension = _ask_user_suspension()
    sink = EventSink()
    conv = MagicMock()
    conv.folder_id = None

    with (
        patch.object(turns_mod, "async_session_factory") as factory,
        patch.object(turns_mod, "ConversationRepository") as conv_repo_cls,
        patch.object(turns_mod, "BoardRepository") as board_repo_cls,
        patch.object(turns_mod, "resolve_local_binding", AsyncMock(return_value=None)),
        patch.object(turns_mod, "resolve_profile_set", AsyncMock(return_value=None)),
        patch.object(turns_mod, "load_chat_context", AsyncMock(return_value=[])),
        patch.object(turns_mod, "build_turn_backend", return_value=MagicMock()),
        patch.object(turns_mod, "session_callbacks", return_value=(AsyncMock(), AsyncMock())),
        patch.object(turns_mod, "suspension_callbacks", return_value=(AsyncMock(), AsyncMock())),
        patch.object(turns_mod, "workspace_lock") as lock,
        patch.object(
            turns_mod,
            "resume_chat_pipeline",
            AsyncMock(
                return_value={
                    "message_id": "msg-1",
                    "content": "done",
                    "finish_reason": FinishReason.END_TURN,
                    "cost_runs": [],
                }
            ),
        ),
        patch.object(turns_mod, "persist_turn_result", AsyncMock()),
        patch.object(turns_mod, "restore_paused_turn", AsyncMock()) as restore,
    ):
        session = AsyncMock()
        factory.return_value.__aenter__.return_value = session
        conv_repo_cls.return_value.get_by_id_unscoped = AsyncMock(return_value=conv)
        board_repo_cls.return_value.get_by_conversation_id = AsyncMock(return_value=None)
        lock.return_value.__aenter__ = AsyncMock(return_value=None)
        lock.return_value.__aexit__ = AsyncMock(return_value=None)

        await turns_mod.resume_chat(
            suspension=suspension,
            response=CheckpointResponse(decision=CheckpointDecision.CONTINUE),
            sink=sink,
        )

    restore.assert_not_awaited()
