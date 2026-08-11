"""IndexMaintainer observability events (start / complete / skip / failed)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import agentcore.workspace.indexing.maintainer as maint_mod
from agentcore.observability.events import get_registry
from agentcore.workspace.indexing.maintainer import IndexMaintainer
from agentcore.workspace.protocol import CodeIndexStatus


@pytest.fixture(autouse=True)
def _short_quiet_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(maint_mod, "_CHANNEL_QUIET_WAIT_MAX_S", 0.05)


async def test_index_build_emits_start_and_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict]] = []

    def _capture(event: str, **kwargs: object) -> None:
        events.append((event, kwargs))

    mock_log = MagicMock()
    mock_log.info.side_effect = _capture
    mock_log.exception.side_effect = lambda event, **kwargs: events.append((event, kwargs))
    monkeypatch.setattr(maint_mod, "logger", mock_log)

    manager = SimpleNamespace(
        set_building=lambda _v: None,
        index_status=lambda: CodeIndexStatus.STALE,
        ensure_index=AsyncMock(return_value=True),
    )
    maintainer = IndexMaintainer(manager, SimpleNamespace())  # type: ignore[arg-type]
    maintainer.schedule(force=True)
    await maintainer.drain()

    names = [n for n, _ in events]
    assert "workspace.index_build_start" in names
    assert "workspace.index_build_complete" in names
    start_kw = next(kw for n, kw in events if n == "workspace.index_build_start")
    complete_kw = next(kw for n, kw in events if n == "workspace.index_build_complete")
    assert start_kw["force"] is True
    assert complete_kw["force"] is True
    assert complete_kw["updated"] is True
    assert isinstance(complete_kw["duration_ms"], int)
    assert complete_kw["duration_ms"] >= 0


async def test_index_skip_channel_busy_emits_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict]] = []
    mock_log = MagicMock()
    mock_log.info.side_effect = lambda event, **kwargs: events.append((event, kwargs))
    monkeypatch.setattr(maint_mod, "logger", mock_log)

    channel = SimpleNamespace(_inflight={"busy"})
    manager = SimpleNamespace(
        set_building=lambda _v: None,
        index_status=lambda: CodeIndexStatus.STALE,
        needs_background_ensure=lambda: True,
        ensure_index=AsyncMock(return_value=False),
    )
    maintainer = IndexMaintainer(manager, SimpleNamespace(_channel=channel))  # type: ignore[arg-type]
    maintainer.schedule(force=True)
    await asyncio.sleep(0.12)
    # Clear so coalesced follow-up can finish without hanging the suite.
    channel._inflight.clear()
    await maintainer.drain()

    skip = next(kw for n, kw in events if n == "workspace.index_skip_channel_busy")
    assert skip["force"] is True
    assert skip["wait_ms"] == 50
    assert skip["inflight"] == 1
    manager.ensure_index.assert_awaited()


async def test_index_failed_emits_context(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[tuple[str, dict]] = []
    mock_log = MagicMock()
    mock_log.info.side_effect = lambda event, **kwargs: events.append((event, kwargs))
    mock_log.exception.side_effect = lambda event, **kwargs: events.append((event, kwargs))
    monkeypatch.setattr(maint_mod, "logger", mock_log)

    manager = SimpleNamespace(
        set_building=lambda _v: None,
        index_status=lambda: CodeIndexStatus.STALE,
        needs_background_ensure=lambda: True,
        ensure_index=AsyncMock(side_effect=RuntimeError("boom")),
    )
    maintainer = IndexMaintainer(manager, SimpleNamespace())  # type: ignore[arg-type]
    maintainer.schedule()
    await maintainer.drain()

    failed = next(kw for n, kw in events if n == "workspace.index_failed")
    assert failed["error"] == "RuntimeError"
    assert isinstance(failed["duration_ms"], int)
    assert "workspace.index_build_start" in {n for n, _ in events}


async def test_schedule_ready_is_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-force schedule when ensure is unnecessary must not start ensure."""
    manager = SimpleNamespace(
        set_building=MagicMock(),
        needs_background_ensure=lambda: False,
        ensure_index=AsyncMock(return_value=False),
    )
    maintainer = IndexMaintainer(manager, SimpleNamespace())  # type: ignore[arg-type]
    maintainer.schedule()
    await asyncio.sleep(0)
    assert maintainer.building is False
    manager.set_building.assert_not_called()
    manager.ensure_index.assert_not_awaited()


async def test_schedule_truncated_stale_without_dirty_is_noop() -> None:
    """Truncated-only STALE must not re-scan (file cap cannot heal)."""
    manager = SimpleNamespace(
        set_building=MagicMock(),
        needs_background_ensure=lambda: False,
        index_status=lambda: CodeIndexStatus.STALE,
        ensure_index=AsyncMock(return_value=False),
    )
    maintainer = IndexMaintainer(manager, SimpleNamespace())  # type: ignore[arg-type]
    maintainer.schedule()
    await asyncio.sleep(0)
    assert maintainer.building is False
    manager.ensure_index.assert_not_awaited()


async def test_schedule_force_runs_when_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SimpleNamespace(
        set_building=lambda _v: None,
        needs_background_ensure=lambda: False,
        ensure_index=AsyncMock(return_value=False),
    )
    maintainer = IndexMaintainer(manager, SimpleNamespace())  # type: ignore[arg-type]
    maintainer.schedule(force=True)
    await maintainer.drain()
    manager.ensure_index.assert_awaited_once()
    assert manager.ensure_index.await_args.kwargs.get("force") is True


def test_index_events_registered_in_catalog() -> None:
    reg = get_registry()
    for name in (
        "workspace.index_build_start",
        "workspace.index_build_complete",
        "workspace.index_skip_channel_busy",
        "workspace.index_failed",
    ):
        assert name in reg
        assert reg.get(name) is not None
