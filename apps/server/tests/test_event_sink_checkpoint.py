"""Tests for EventSink progressive content checkpointing."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.runtime.events import (
    EventSink,
    content_delta,
    run_completed,
    run_failed,
    run_started,
)


@pytest.fixture
def checkpoint_repo():
    repo = MagicMock()
    repo.update_assistant_content = AsyncMock()
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    with (
        patch(
            "agentcore.db.base.async_session_factory",
            return_value=session,
        ),
        patch(
            "agentcore.db.repositories.MessageRepository",
            return_value=repo,
        ),
    ):
        yield repo


@pytest.mark.asyncio
async def test_checkpoint_persists_streamed_content(checkpoint_repo):
    sink = EventSink()
    sink.bind_content_checkpoint(conversation_id="c1", message_id="m1")
    sink.emit(content_delta("hello "))
    sink.emit(content_delta("world"))

    await sink._do_checkpoint()

    checkpoint_repo.update_assistant_content.assert_awaited_once_with(
        conversation_id="c1",
        message_id="m1",
        content="hello world",
    )


@pytest.mark.asyncio
async def test_checkpoint_skips_unchanged_content(checkpoint_repo):
    sink = EventSink()
    sink.bind_content_checkpoint(conversation_id="c1", message_id="m1")
    sink.emit(content_delta("same"))

    await sink._do_checkpoint()
    await sink._do_checkpoint()

    checkpoint_repo.update_assistant_content.assert_awaited_once()


@pytest.mark.asyncio
async def test_worker_run_completed_triggers_checkpoint(checkpoint_repo):
    sink = EventSink()
    sink.bind_content_checkpoint(conversation_id="c1", message_id="m1")
    sink.emit(content_delta("after worker"))
    sink.emit(run_started("cap-1", "CEO", kind="captain"))
    sink.emit(run_completed("w1", "worker", output_summary="done", duration_ms=1))

    await asyncio.sleep(0)

    checkpoint_repo.update_assistant_content.assert_awaited()
    assert checkpoint_repo.update_assistant_content.await_args.kwargs["content"] == "after worker"


@pytest.mark.asyncio
async def test_captain_run_completed_does_not_trigger_checkpoint(checkpoint_repo):
    sink = EventSink()
    sink.bind_content_checkpoint(conversation_id="c1", message_id="m1")
    sink.emit(content_delta("captain reply"))
    sink.emit(run_started("cap-1", "CEO", kind="captain"))
    sink.emit(
        run_completed(
            "cap-1",
            "CEO",
            output_summary="",
            duration_ms=1,
            role="captain",
        )
    )

    await asyncio.sleep(0)

    checkpoint_repo.update_assistant_content.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_run_failed_triggers_checkpoint(checkpoint_repo):
    sink = EventSink()
    sink.bind_content_checkpoint(conversation_id="c1", message_id="m1")
    sink.emit(content_delta("partial"))
    sink.emit(run_started("cap-1", "CEO", kind="captain"))
    sink.emit(run_failed("w1", "worker", "boom"))

    await asyncio.sleep(0)

    checkpoint_repo.update_assistant_content.assert_awaited_once()
    assert checkpoint_repo.update_assistant_content.await_args.kwargs["content"] == "partial"


@pytest.mark.asyncio
async def test_close_cancels_checkpoint_loop():
    sink = EventSink()
    sink.bind_content_checkpoint(conversation_id="c1", message_id="m1")
    assert sink._checkpoint_task is not None

    sink.close()

    await asyncio.sleep(0)
    assert sink._checkpoint_task is None
    assert sink._closed


def test_checkpoint_noop_without_bind():
    sink = EventSink()
    sink.emit(content_delta("orphan"))
    sink.checkpoint_now()
    assert sink._checkpoint_inflight is None
