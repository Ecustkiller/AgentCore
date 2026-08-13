"""Boot probe for a usable ``git`` binary (mirrors ``test_cloud_sandbox_health``).

The cloud image shipped without ``git`` for a long time, which turned every
server-side git call into a raw ``FileNotFoundError``. The probe exists so the
registries can withhold the tool instead; it must therefore be unable to break
startup itself, whatever the environment throws.
"""

from __future__ import annotations

import asyncio
import shutil
from typing import Any

import pytest

from agentcore.tools.builtin.git_ops import binary_health
from agentcore.tools.builtin.git_ops.binary_health import (
    git_binary_health,
    git_binary_health_failure,
    probe_git_binary_at_startup,
    reset_git_binary_health_for_tests,
)


@pytest.fixture(autouse=True)
def _reset_probe_cache():
    """Process-wide cache: leaking a verdict would silently gate other suites."""
    reset_git_binary_health_for_tests()
    yield
    reset_git_binary_health_for_tests()


class _FakeProc:
    def __init__(self, *, stdout: bytes = b"", returncode: int = 0, hang: bool = False):
        self._stdout = stdout
        self.returncode = returncode
        self._hang = hang
        self.killed = False

    async def communicate(self) -> tuple[bytes, bytes]:
        if self._hang:
            await asyncio.sleep(30)
        return self._stdout, b""

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        return -9


def _patch_spawn(monkeypatch: pytest.MonkeyPatch, result: Any) -> None:
    async def _spawn(*_args: Any, **_kwargs: Any) -> Any:
        if isinstance(result, BaseException):
            raise result
        return result

    monkeypatch.setattr(binary_health.asyncio, "create_subprocess_exec", _spawn)


@pytest.mark.asyncio
async def test_unprobed_cache_is_none():
    assert git_binary_health() is None


@pytest.mark.asyncio
async def test_probe_success_caches_available(monkeypatch: pytest.MonkeyPatch):
    _patch_spawn(monkeypatch, _FakeProc(stdout=b"git version 2.43.0"))
    await probe_git_binary_at_startup()
    assert git_binary_health() is True
    assert git_binary_health_failure() is None


@pytest.mark.asyncio
async def test_missing_binary_caches_not_found(monkeypatch: pytest.MonkeyPatch):
    """The case this module exists for: no ``git`` on PATH."""
    _patch_spawn(monkeypatch, FileNotFoundError(2, "No such file or directory: 'git'"))
    await probe_git_binary_at_startup()
    assert git_binary_health() is False
    failure = git_binary_health_failure()
    assert failure is not None and failure[0] == "not_found"


@pytest.mark.asyncio
async def test_nonzero_exit_caches_unavailable(monkeypatch: pytest.MonkeyPatch):
    _patch_spawn(monkeypatch, _FakeProc(stdout=b"boom", returncode=127))
    await probe_git_binary_at_startup()
    assert git_binary_health() is False
    failure = git_binary_health_failure()
    assert failure is not None and failure[0] == "nonzero_exit"


@pytest.mark.asyncio
async def test_wedged_probe_is_bounded_and_kills(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(binary_health, "_GIT_PROBE_TIMEOUT", 0.05)
    proc = _FakeProc(hang=True)
    _patch_spawn(monkeypatch, proc)
    await probe_git_binary_at_startup()
    assert git_binary_health() is False
    failure = git_binary_health_failure()
    assert failure is not None and failure[0] == "probe_timeout"
    assert proc.killed is True


@pytest.mark.asyncio
async def test_unexpected_exception_never_breaks_startup(monkeypatch: pytest.MonkeyPatch):
    _patch_spawn(monkeypatch, RuntimeError("event loop went sideways"))
    await probe_git_binary_at_startup()
    assert git_binary_health() is False


@pytest.mark.skipif(shutil.which("git") is None, reason="no git on PATH")
@pytest.mark.asyncio
async def test_probe_recognises_a_real_git():
    """Guards against a probe that only ever passes against fakes."""
    await probe_git_binary_at_startup()
    assert git_binary_health() is True
