"""Journal writer degradation marks paused frames."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from agentcore.runtime.journal.writer import TurnJournalWriter, current_journal_writer
from agentcore.runtime.suspension import AskUserSuspension, SuspensionKind
from agentcore.runtime.suspension_persistence import save_paused_turn


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
    )


@pytest.mark.asyncio
async def test_save_paused_turn_marks_degraded_when_writer_failed() -> None:
    suspension = _ask_user_suspension()
    writer = TurnJournalWriter(
        turn_id="msg-1",
        conversation_id="conv-1",
        trace_id="trace-1",
    )
    writer._degraded = True  # noqa: SLF001 — simulate append failures
    token = current_journal_writer.set(writer)
    try:
        with patch(
            "agentcore.runtime.suspension_persistence.async_session_factory"
        ) as factory:
            session = AsyncMock()
            factory.return_value.__aenter__.return_value = session
            with patch(
                "agentcore.runtime.suspension_persistence.PausedTurnRepository"
            ) as repo_cls:
                repo_cls.return_value.upsert = AsyncMock()
                with patch(
                    "agentcore.runtime.suspension_persistence._notify_pause",
                    AsyncMock(),
                ):
                    await save_paused_turn(suspension)
    finally:
        current_journal_writer.reset(token)
    assert suspension.journal_degraded is True
    frame = repo_cls.return_value.upsert.await_args.kwargs["frame"]
    assert frame["journal_degraded"] is True
    assert frame["kind"] == SuspensionKind.ASK_USER.value


def test_resumed_captain_window_raises_on_journal_degraded() -> None:
    from agentcore.core.errors import ResumeJournalDegradedError
    from agentcore.runtime.pipeline.resume.window import resumed_captain_window

    suspension = _ask_user_suspension()
    suspension.journal_degraded = True
    with pytest.raises(ResumeJournalDegradedError, match="执行日志保存失败"):
        resumed_captain_window(suspension, history=[])
