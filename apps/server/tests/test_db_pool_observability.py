"""Pool holder observability: exhaustion snapshot + slow checkout + attribution."""

from __future__ import annotations

import asyncio
import time
from types import FrameType
from typing import Any
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import TimeoutError as SATimeoutError
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from agentcore.config.database import DatabaseSettings
from agentcore.core.log_context import bind_log_context, clear_log_context, get_log_value
from agentcore.db import pool_observability as pool_obs
from agentcore.db.pool_observability import PoolCheckoutTracker, _capture_stack, _frame_is_noise
from agentcore.middleware.request_attribution import RequestAttributionMiddleware
from tests.conftest import LogSpy


class _FakeRecord:
    """Stand-in for SQLAlchemy ConnectionPoolEntry (identity-keyed)."""


def _tracker(**overrides: object) -> PoolCheckoutTracker:
    defaults: dict[str, object] = {
        "name": "primary",
        "capacity": 4,
        "hold_warn_s": 0.05,
        "trace_occupancy": 0.75,
        "stack_frames": 4,
        "snapshot_cooldown_s": 0.0,
    }
    defaults.update(overrides)
    return PoolCheckoutTracker(**defaults)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _clear_log_ctx() -> None:
    clear_log_context()
    yield
    clear_log_context()


def test_pool_observability_settings_defaults_are_conservative() -> None:
    fields = DatabaseSettings.model_fields
    assert fields["db_pool_hold_warn_s"].default == 10.0
    assert fields["db_pool_trace_occupancy"].default == 0.75
    assert fields["db_pool_stack_frames"].default == 8
    assert fields["db_pool_exhaustion_snapshot_cooldown_s"].default == 5.0
    # Capacity defaults unchanged (observation must not expand the pool).
    assert fields["db_pool_size"].default == 16
    assert fields["db_max_overflow"].default == 16


def test_exhaustion_snapshot_includes_holder_context(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)

    bind_log_context(
        trace_id="aabbccddeeff00112233445566778899",
        conversation_id="conv-holder-1",
        run_id="run-holder-1",
        agent_id="agent-ceo",
        http_method="POST",
        http_path="/v1/conversations/c1/messages",
        http_req_id="abc123def456",
    )
    tracker = _tracker(hold_warn_s=999.0)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    tracker.emit_exhaustion_snapshot()

    payload = spy.get("db.pool_exhausted_snapshot")
    assert payload["pool"] == "primary"
    assert payload["checked_out"] == 1
    assert payload["capacity"] == 4
    holders = payload["holders"]
    assert isinstance(holders, list) and len(holders) == 1
    holder = holders[0]
    assert holder["trace_id"] == "aabbccddeeff00112233445566778899"
    assert holder["conversation_id"] == "conv-holder-1"
    assert holder["run_id"] == "run-holder-1"
    assert holder["agent_id"] == "agent-ceo"
    assert holder["http_method"] == "POST"
    assert holder["http_path"] == "/v1/conversations/c1/messages"
    assert holder["http_req_id"] == "abc123def456"
    assert isinstance(holder["held_s"], float)
    assert holder["held_s"] >= 0.0


def test_slow_checkout_emits_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)

    bind_log_context(
        trace_id="slowtrace000000000000000000000001",
        conversation_id="conv-slow",
        http_method="GET",
        http_path="/v1/documents",
        http_req_id="slowreq00001",
    )
    tracker = _tracker(hold_warn_s=0.01, trace_occupancy=1.1)  # never capture stack
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    time.sleep(0.02)
    tracker._on_checkin(None, record)

    payload = spy.get("db.pool_checkout_slow")
    assert payload["pool"] == "primary"
    assert payload["held_s"] >= 0.01
    assert payload["trace_id"] == "slowtrace000000000000000000000001"
    assert payload["conversation_id"] == "conv-slow"
    assert payload["http_method"] == "GET"
    assert payload["http_path"] == "/v1/documents"
    assert payload["http_req_id"] == "slowreq00001"


def test_fast_checkout_does_not_warn(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)
    tracker = _tracker(hold_warn_s=30.0)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    tracker._on_checkin(None, record)
    assert not any(name == "db.pool_checkout_slow" for name, _ in spy.events)


def test_high_occupancy_captures_stack() -> None:
    tracker = _tracker(capacity=2, trace_occupancy=0.5, stack_frames=4)
    r1, r2 = _FakeRecord(), _FakeRecord()
    tracker._on_checkout(None, r1, None)
    tracker._on_checkout(None, r2, None)
    snaps = tracker.holder_snapshots()
    assert len(snaps) == 2
    # Second checkout is at 100% occupancy → stack present.
    assert snaps[1].get("stack")


def test_low_occupancy_skips_stack() -> None:
    tracker = _tracker(capacity=10, trace_occupancy=0.75, stack_frames=8)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    snaps = tracker.holder_snapshots()
    assert len(snaps) == 1
    assert "stack" not in snaps[0]


def test_snapshot_cooldown_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)
    tracker = _tracker(snapshot_cooldown_s=60.0)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    tracker.emit_exhaustion_snapshot()
    tracker.emit_exhaustion_snapshot()
    assert sum(1 for name, _ in spy.events if name == "db.pool_exhausted_snapshot") == 1


def test_invalidate_drops_holder() -> None:
    tracker = _tracker()
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    assert len(tracker.holder_snapshots()) == 1
    tracker._on_invalidate(None, record, None)
    assert tracker.holder_snapshots() == []


def test_do_get_wrapper_emits_snapshot_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wrapping pool._do_get is how every call site gets a holder snapshot."""
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)

    tracker = _tracker(snapshot_cooldown_s=0.0)
    holder = _FakeRecord()
    bind_log_context(
        trace_id="wraptrace00000000000000000000001",
        conversation_id="conv-wrap",
        http_path="/v1/wrap",
        http_req_id="wrapreq00001",
    )
    tracker._on_checkout(None, holder, None)
    clear_log_context()

    class _Pool:
        def _do_get(self):
            raise SATimeoutError("QueuePool limit of size 2 overflow 0 reached")

    class _SyncEngine:
        def __init__(self) -> None:
            self.pool = _Pool()

    class _AsyncEngine:
        def __init__(self) -> None:
            self.sync_engine = _SyncEngine()

    # Bypass real event.listen; only exercise the _do_get wrap path.
    engine = _AsyncEngine()
    pool = engine.sync_engine.pool
    orig = pool._do_get

    def _do_get_tracked():
        try:
            return orig()
        except SATimeoutError:
            tracker.emit_exhaustion_snapshot()
            raise

    pool._do_get = _do_get_tracked  # type: ignore[method-assign]

    with pytest.raises(SATimeoutError):
        pool._do_get()

    payload = spy.get("db.pool_exhausted_snapshot")
    holders = payload["holders"]
    assert len(holders) == 1
    assert holders[0]["trace_id"] == "wraptrace00000000000000000000001"
    assert holders[0]["conversation_id"] == "conv-wrap"
    assert holders[0]["http_path"] == "/v1/wrap"
    assert holders[0]["http_req_id"] == "wrapreq00001"


def test_greenlet_compile_frames_are_noise() -> None:
    assert _frame_is_noise("<string>", "_connection_for_bind")
    assert _frame_is_noise(
        "/venv/lib/python3.12/site-packages/sqlalchemy/orm/session.py", "execute"
    )
    assert not _frame_is_noise(
        "/app/agentcore/api/routes/conversations/messages.py", "send_message"
    )


def test_agentcore_frames_survive_a_non_editable_install() -> None:
    """``uv sync --no-editable`` puts our own package under site-packages."""
    installed = "/app/.venv/lib/python3.12/site-packages/agentcore/db/repositories/messages.py"
    assert not _frame_is_noise(installed, "create")
    # Our own tracker stays noise wherever it is installed.
    assert _frame_is_noise(
        "/app/.venv/lib/python3.12/site-packages/agentcore/db/pool_observability.py",
        "_on_checkout",
    )


def test_capture_stack_prefers_agentcore_task_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    """Greenlet trampoline frames must not crowd out agentcore business frames."""

    def _fake_frame(filename: str, name: str, lineno: int = 1) -> MagicMock:
        frame = MagicMock(spec=FrameType)
        frame.f_code.co_filename = filename
        frame.f_code.co_name = name
        frame.f_lineno = lineno
        return frame

    noise = _fake_frame("<string>", "_connection_for_bind", 2)
    sa = _fake_frame("/site-packages/sqlalchemy/engine/base.py", "connect", 10)
    app_route = _fake_frame(
        "/repo/apps/server/agentcore/api/routes/conversations/messages.py",
        "send_message",
        340,
    )
    app_repo = _fake_frame(
        "/repo/apps/server/agentcore/db/repositories/messages.py",
        "create",
        88,
    )

    fake_task = MagicMock()
    # get_stack is oldest→newest; include noise at the end (nearest the await).
    fake_task.get_stack.return_value = [app_route, app_repo, sa, noise]
    monkeypatch.setattr(asyncio, "current_task", lambda: fake_task)

    stack = _capture_stack(4)
    assert stack
    assert all("agentcore/" in frame for frame in stack)
    assert not any("_connection_for_bind" in frame for frame in stack)
    assert any("send_message" in frame for frame in stack)


@pytest.mark.parametrize("task_frames", [[], "trampoline-only"])
def test_capture_stack_falls_back_to_sync_frames(
    monkeypatch: pytest.MonkeyPatch, task_frames: Any
) -> None:
    """An unusable coroutine stack must not yield an empty (unattributable) holder."""
    if task_frames == "trampoline-only":
        noise = MagicMock(spec=FrameType)
        noise.f_code.co_filename = "<string>"
        noise.f_code.co_name = "_connection_for_bind"
        noise.f_lineno = 2
        task_frames = [noise]

    fake_task = MagicMock()
    fake_task.get_stack.return_value = task_frames
    monkeypatch.setattr(asyncio, "current_task", lambda: fake_task)

    stack = _capture_stack(4)
    assert stack, "expected the synchronous caller stack as a fallback"
    assert any("test_capture_stack_falls_back_to_sync_frames" in frame for frame in stack)


@pytest.mark.asyncio
async def test_request_attribution_middleware_binds_http_context() -> None:
    seen: dict[str, Any] = {}

    async def homepage(_request):  # noqa: ANN001
        seen["method"] = get_log_value("http_method")
        seen["path"] = get_log_value("http_path")
        seen["req_id"] = get_log_value("http_req_id")
        task = asyncio.current_task()
        seen["task_name"] = task.get_name() if task else ""
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/v1/ping", homepage)])
    app.add_middleware(RequestAttributionMiddleware)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/v1/ping")
    assert resp.status_code == 200
    assert seen["method"] == "GET"
    assert seen["path"] == "/v1/ping"
    assert len(seen["req_id"]) == 12
    assert seen["task_name"] == "http:GET /v1/ping"


@pytest.mark.asyncio
async def test_checkout_sees_http_context_from_same_task() -> None:
    """Attribution must be bound before checkout — same task as the handler."""
    tracker = _tracker(hold_warn_s=999.0, trace_occupancy=1.1)
    record = _FakeRecord()
    captured: dict[str, Any] = {}

    async def handler(_request):  # noqa: ANN001
        tracker._on_checkout(None, record, None)
        snaps = tracker.holder_snapshots()
        captured["holder"] = snaps[0]
        captured["task_name"] = asyncio.current_task().get_name()  # type: ignore[union-attr]
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/v1/hold", handler, methods=["POST"])])
    app.add_middleware(RequestAttributionMiddleware)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/v1/hold")
    assert resp.status_code == 200
    holder = captured["holder"]
    assert holder["http_method"] == "POST"
    assert holder["http_path"] == "/v1/hold"
    assert holder["http_req_id"]
    assert holder["task_name"] == "http:POST /v1/hold"
    assert captured["task_name"] == "http:POST /v1/hold"
