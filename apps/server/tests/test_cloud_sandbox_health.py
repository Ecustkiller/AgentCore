"""Boot-time cloud sandbox health probe → ``code_execution_enabled_for`` gate."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agentcore.config import settings
from agentcore.tools.builtin import code_execution_enabled_for
from agentcore.tools.sandbox.cloud_health import (
    cloud_sandbox_health,
    probe_cloud_sandbox_at_startup,
    set_cloud_sandbox_health_for_tests,
)
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from tests.delegate.conftest import LocalBackend


class _FakeSandbox:
    def __init__(
        self,
        *,
        ok: bool = True,
        raise_exc: BaseException | None = None,
        last_health_failure: tuple[str, str | None] | None = None,
    ):
        self._ok = ok
        self._raise = raise_exc
        self.last_health_failure = last_health_failure

    async def health_check(self) -> bool:
        if self._raise is not None:
            raise self._raise
        return self._ok


class _SandboxWithoutHealth:
    """Provider that omits ``health_check`` — must be treated as unhealthy."""


@pytest.mark.asyncio
async def test_probe_skipped_when_cloud_execution_config_off(monkeypatch: pytest.MonkeyPatch):
    called: list[Any] = []

    def _boom() -> Any:
        called.append(True)
        raise AssertionError("sandbox must not be built when config is off")

    monkeypatch.setattr(
        "agentcore.workspace.locate._default_server_sandbox",
        _boom,
    )
    await probe_cloud_sandbox_at_startup()
    assert cloud_sandbox_health() is None
    assert called == []


@pytest.mark.asyncio
async def test_probe_success_caches_healthy(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "gvisor_enabled", True)
    monkeypatch.setattr(
        "agentcore.workspace.locate._default_server_sandbox",
        lambda: _FakeSandbox(ok=True),
    )
    await probe_cloud_sandbox_at_startup()
    assert cloud_sandbox_health() is True


@pytest.mark.asyncio
async def test_probe_failure_caches_unhealthy(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "code_execute_cloud_enabled", True)
    monkeypatch.setattr(settings, "code_execute_cloud_unsafe_ack", True)
    monkeypatch.setattr(
        "agentcore.workspace.locate._default_server_sandbox",
        lambda: _FakeSandbox(ok=False),
    )
    await probe_cloud_sandbox_at_startup()
    assert cloud_sandbox_health() is False


@pytest.mark.asyncio
async def test_probe_surfaces_sandbox_last_health_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    """GVisor ``last_health_failure`` (e.g. not_linux) must reach the warning reason."""
    set_cloud_sandbox_health_for_tests(None)
    logged: list[dict[str, Any]] = []

    class _Logger:
        def debug(self, *_a: Any, **_k: Any) -> None:
            return None

        def warning(self, event: str, **kwargs: Any) -> None:
            logged.append({"event": event, **kwargs})

    monkeypatch.setattr(settings, "gvisor_enabled", True)
    monkeypatch.setattr(
        "agentcore.workspace.locate._default_server_sandbox",
        lambda: _FakeSandbox(
            ok=False,
            last_health_failure=("not_linux", "platform=win32"),
        ),
    )
    monkeypatch.setattr(
        "agentcore.tools.sandbox.cloud_health.logger",
        _Logger(),
    )
    await probe_cloud_sandbox_at_startup()
    assert cloud_sandbox_health() is False
    assert logged and logged[0]["event"] == "sandbox.cloud_health_failed"
    assert logged[0]["reason"] == "not_linux"
    assert logged[0]["detail"] == "platform=win32"


@pytest.mark.asyncio
async def test_probe_exception_caches_unhealthy_without_raising(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "gvisor_enabled", True)
    monkeypatch.setattr(
        "agentcore.workspace.locate._default_server_sandbox",
        lambda: _FakeSandbox(raise_exc=RuntimeError("runsc gone")),
    )
    await probe_cloud_sandbox_at_startup()
    assert cloud_sandbox_health() is False


@pytest.mark.asyncio
async def test_probe_missing_health_check_caches_unhealthy(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "gvisor_enabled", True)
    monkeypatch.setattr(
        "agentcore.workspace.locate._default_server_sandbox",
        lambda: _SandboxWithoutHealth(),
    )
    await probe_cloud_sandbox_at_startup()
    assert cloud_sandbox_health() is False


def test_local_backend_ignores_unhealthy_cloud_probe(tmp_path: Path):
    set_cloud_sandbox_health_for_tests(False)
    assert code_execution_enabled_for(LocalBackend()) is True
    # Server backend with config off stays false regardless of probe.
    assert code_execution_enabled_for(ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())) is False
