"""Harvest task lifecycle: strong refs + cancelled harvest is observable."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

import agentcore.runtime.coordination.harvest as harvest_mod
import agentcore.runtime.coordination.session as session_mod
from agentcore.runtime.coordination.session import (
    CoordinationSession,
    clear_active_coordination,
)
from tests.conftest import LogSpy


@pytest.fixture(autouse=True)
def _clean_coordination():
    clear_active_coordination()
    yield
    clear_active_coordination()


def _detached_session(eid: str = "exec-harvest-life") -> CoordinationSession:
    session = CoordinationSession(
        execution_id=eid,
        total_workers=1,
        conversation_id="conv-harvest-life",
    )
    session.turn_attached = False
    return session


@pytest.mark.asyncio
async def test_arm_harvest_now_holds_task_ref_until_done():
    session = _detached_session("exec-harvest-retain")
    gate = asyncio.Event()

    async def _block(*_a: object, **_k: object) -> None:
        await gate.wait()

    with patch(
        "agentcore.runtime.coordination.harvest.harvest_detached_execution",
        _block,
    ):
        session_mod._arm_harvest_now(session)

    assert len(session._harvest_tasks) == 1
    task = next(iter(session._harvest_tasks))
    assert not task.done()

    gate.set()
    await task
    await asyncio.sleep(0)
    assert session._harvest_tasks == set()


@pytest.mark.asyncio
async def test_run_harvest_logs_cancelled(monkeypatch: pytest.MonkeyPatch):
    """3.13: cancel before the task starts never enters the coroutine body."""
    spy = LogSpy()
    monkeypatch.setattr(session_mod, "logger", spy)
    session = _detached_session("exec-harvest-cancel")
    hang = asyncio.Event()

    async def _block(*_a: object, **_k: object) -> None:
        await hang.wait()

    with patch(
        "agentcore.runtime.coordination.harvest.harvest_detached_execution",
        _block,
    ):
        session_mod._arm_harvest_now(session)
        task = next(iter(session._harvest_tasks))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert spy.get("coordination.harvest_cancelled")["execution_id"] == (
        "exec-harvest-cancel"
    )
    await asyncio.sleep(0)
    assert session._harvest_tasks == set()


@pytest.mark.asyncio
async def test_run_harvest_logs_cancelled_after_start(
    monkeypatch: pytest.MonkeyPatch,
):
    spy = LogSpy()
    monkeypatch.setattr(session_mod, "logger", spy)
    session = _detached_session("exec-harvest-cancel-started")
    hang = asyncio.Event()

    async def _block(*_a: object, **_k: object) -> None:
        await hang.wait()

    with patch(
        "agentcore.runtime.coordination.harvest.harvest_detached_execution",
        _block,
    ):
        session_mod._arm_harvest_now(session)
        task = next(iter(session._harvest_tasks))
        await asyncio.sleep(0)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert spy.get("coordination.harvest_cancelled")["execution_id"] == (
        "exec-harvest-cancel-started"
    )
    await asyncio.sleep(0)
    assert session._harvest_tasks == set()


@pytest.mark.asyncio
async def test_harvest_detached_execution_logs_entry(
    monkeypatch: pytest.MonkeyPatch,
):
    spy = LogSpy()
    monkeypatch.setattr(harvest_mod, "logger", spy)
    session = CoordinationSession(
        execution_id="exec-harvest-entry",
        total_workers=1,
        conversation_id="conv-harvest-entry",
    )
    session.turn_attached = True
    session.harvest_scheduled = True
    session.mark_settled("harvest")

    await harvest_mod.harvest_detached_execution(session)

    fields = spy.get("coordination.harvest_detached_started")
    assert fields["execution_id"] == "exec-harvest-entry"
    assert fields["turn_attached"] is True
    assert spy.get("coordination.harvest_skipped_reattached")
