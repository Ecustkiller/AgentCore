"""Unit tests for handoff cloud-replica reclaim (§7.6 按任务临时、结束可收).

Covers apply→applied+soft-delete host, discard path, and retention aging of open
hosts — without DB/desktop/OSS (repos and soft-delete are faked). Diff remaining
usable until discard/retention is asserted by the open-job aging gate (no early
soft-delete on succeed).
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from agentcore.config import settings
from agentcore.workspace import handoff_reclaim
from agentcore.workspace import retention as retention_mod
from agentcore.workspace.handoff_reclaim import reclaim_after_apply, reclaim_after_discard

pytestmark = pytest.mark.anyio


class _Job:
    def __init__(self, **kw):
        self.id = kw.get("id", "job-1")
        self.user_id = kw.get("user_id", "u1")
        self.job_conversation_id = kw.get("job_conversation_id", "host-1")
        self.status = kw.get("status", "succeeded")
        self.finished_at = kw.get("finished_at")


async def test_reclaim_after_apply_marks_and_soft_deletes(monkeypatch):
    events: list = []

    class _FakeJobRepo:
        def __init__(self, _session):
            pass

        async def mark_applied(self, job_id):
            events.append(("applied", job_id))
            return True

    class _FakeSessionCM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_exc):
            return False

    async def _soft_delete(*, user_id, job_conversation_id):
        events.append(("soft_delete", user_id, job_conversation_id))
        return True

    monkeypatch.setattr(handoff_reclaim, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(handoff_reclaim, "HandoffJobRepository", _FakeJobRepo)
    monkeypatch.setattr(handoff_reclaim, "soft_delete_job_host", _soft_delete)

    await reclaim_after_apply(job_id="job-1", user_id="u1", job_conversation_id="host-1")
    assert events == [("applied", "job-1"), ("soft_delete", "u1", "host-1")]


async def test_reclaim_after_discard_marks_and_soft_deletes(monkeypatch):
    events: list = []

    class _FakeJobRepo:
        def __init__(self, _session):
            pass

        async def mark_discarded(self, job_id):
            events.append(("discarded", job_id))
            return True

    class _FakeSessionCM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_exc):
            return False

    async def _soft_delete(*, user_id, job_conversation_id):
        events.append(("soft_delete", user_id, job_conversation_id))
        return True

    monkeypatch.setattr(handoff_reclaim, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(handoff_reclaim, "HandoffJobRepository", _FakeJobRepo)
    monkeypatch.setattr(handoff_reclaim, "soft_delete_job_host", _soft_delete)

    ok = await reclaim_after_discard(
        job_id="job-1", user_id="u1", job_conversation_id="host-1"
    )
    assert ok is True
    assert events == [("discarded", "job-1"), ("soft_delete", "u1", "host-1")]


async def test_reclaim_after_discard_skips_soft_delete_when_not_open(monkeypatch):
    events: list = []

    class _FakeJobRepo:
        def __init__(self, _session):
            pass

        async def mark_discarded(self, job_id):
            events.append(("discarded", job_id))
            return False  # already applied / discarded

    class _FakeSessionCM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_exc):
            return False

    async def _soft_delete(**_kw):
        events.append(("soft_delete",))
        return True

    monkeypatch.setattr(handoff_reclaim, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(handoff_reclaim, "HandoffJobRepository", _FakeJobRepo)
    monkeypatch.setattr(handoff_reclaim, "soft_delete_job_host", _soft_delete)

    ok = await reclaim_after_discard(
        job_id="job-1", user_id="u1", job_conversation_id="host-1"
    )
    assert ok is False
    assert events == [("discarded", "job-1")]  # no soft_delete


async def test_retention_ages_open_handoff_hosts_only(monkeypatch):
    """Open finished jobs past the Diff window soft-delete; recent ones stay."""
    aged_calls: list = []
    old = _Job(
        id="old",
        finished_at=datetime.now(UTC) - timedelta(days=40),
        job_conversation_id="host-old",
    )

    class _FakeJobRepo:
        def __init__(self, _session):
            pass

        async def list_open_past_retention(self, *, before, limit):
            assert limit == settings.workspace_retention_batch_limit
            # Caller passes now - retention_days; only return aged open jobs.
            return [old]

    class _FakeFolderRepo:
        def __init__(self, _session):
            pass

        async def list_purgeable(self, *, before, limit):
            return []

    class _FakeConvRepo:
        def __init__(self, _session):
            pass

        async def list_purgeable(self, *, before, limit):
            return []

    class _FakeSessionCM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_exc):
            return False

    async def _soft_delete(*, user_id, job_conversation_id):
        aged_calls.append((user_id, job_conversation_id))
        return True

    monkeypatch.setattr(settings, "workspace_retention_enabled", True)
    monkeypatch.setattr(retention_mod, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(retention_mod, "HandoffJobRepository", _FakeJobRepo)
    monkeypatch.setattr(retention_mod, "FolderRepository", _FakeFolderRepo)
    monkeypatch.setattr(retention_mod, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(retention_mod, "soft_delete_job_host", _soft_delete)

    result = await retention_mod.run_retention_sweep()
    assert result == {"folders": 0, "conversations": 0, "handoff_hosts_aged": 1}
    assert aged_calls == [("u1", "host-old")]


async def test_retention_does_not_age_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "workspace_retention_enabled", False)
    # Would raise if aging ran with missing fakes.
    monkeypatch.setattr(
        retention_mod,
        "_age_open_handoff_hosts",
        AsyncMock(side_effect=AssertionError("must not age")),
    )
    assert await retention_mod.run_retention_sweep() == {
        "folders": 0,
        "conversations": 0,
        "handoff_hosts_aged": 0,
    }


async def test_run_apply_calls_reclaim_after_success(monkeypatch):
    """Apply SSE driver must mark applied + soft-delete host after a clean pass."""
    from agentcore.api.routes.conversations import handoff as handoff_route
    from agentcore.runtime.events import EventSink
    from agentcore.workspace.locate import LocalBinding

    reclaim = AsyncMock()
    monkeypatch.setattr(handoff_route, "reclaim_after_apply", reclaim)
    monkeypatch.setattr(handoff_route, "build_workspace", lambda **_kw: object())
    monkeypatch.setattr(
        handoff_route,
        "apply_handoff",
        AsyncMock(return_value=[]),
    )

    sink = EventSink()
    await handoff_route._run_apply(
        user_id="u1",
        source_folder_id=None,
        source_conversation_id="src",
        job_id="job-1",
        job_conversation_id="host-1",
        base_snapshot_id="base",
        result_snapshot_id="res",
        binding=LocalBinding(root_id="r1"),
        selections=[],
        sink=sink,
    )

    reclaim.assert_awaited_once_with(
        job_id="job-1", user_id="u1", job_conversation_id="host-1"
    )
