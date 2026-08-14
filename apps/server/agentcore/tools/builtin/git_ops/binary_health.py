"""Process-level ``git`` binary availability (boot probe → capability gate).

One-shot at app lifespan, mirroring ``tools.sandbox.cloud_health``: the cached
result folds into ``git_execution_enabled_for`` so worker registration and the
``workspace_context`` capability line stay aligned with what this process can
actually spawn. ``None`` (never probed) keeps the pre-probe semantics for tests
and unbooted processes.

Scope: this answers "can the CURRENT process exec ``git``", which is the right
question only for the in-process transport (cloud ``ServerWorkspace`` and the
sidecar). A channel-backed ``LocalWorkspace`` runs git on the user's machine over
``WorkspaceOp.GIT_RUN``, so it must never be gated on this probe — see the
predicate.
"""

from __future__ import annotations

import asyncio

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

# ``git --version`` is a local, no-I/O command; a missing binary raises OSError
# immediately rather than waiting this out. The bound only covers a wedged exec.
_GIT_PROBE_TIMEOUT = 5.0

# None = never probed → predicate keeps pre-probe semantics (tool stays offered).
_git_binary_available: bool | None = None
# Last failing probe reason (cleared when available / reset).
_git_binary_failure: tuple[str, str | None] | None = None


def git_binary_health() -> bool | None:
    """Cached boot-probe result: ``True`` / ``False``, or ``None`` if never probed."""
    return _git_binary_available


def git_binary_health_failure() -> tuple[str, str | None] | None:
    """``(reason, detail)`` from the last failing probe; else ``None``."""
    return _git_binary_failure


def reset_git_binary_health_for_tests() -> None:
    """Clear the process-wide cache so tests cannot leak health across cases."""
    global _git_binary_available, _git_binary_failure
    _git_binary_available = None
    _git_binary_failure = None


def set_git_binary_health_for_tests(
    available: bool | None,
    *,
    failure: tuple[str, str | None] | None = None,
) -> None:
    """Inject a probe result for unit tests (``None`` = unprobed)."""
    global _git_binary_available, _git_binary_failure
    _git_binary_available = available
    if available is True:
        _git_binary_failure = None
    elif failure is not None:
        _git_binary_failure = failure
    elif available is False and _git_binary_failure is None:
        _git_binary_failure = ("unavailable", None)
    elif available is None:
        _git_binary_failure = None


async def probe_git_binary_at_startup() -> None:
    """One-shot boot probe for a usable ``git`` on PATH. Never raises.

    A missing binary is the case this exists for: the cloud image shipped without
    ``git`` for a long time, which turned every server-side git call into a raw
    ``FileNotFoundError``. Caching the verdict lets the registries withhold the
    tool instead, and the capability line say 未装配 honestly.
    """
    global _git_binary_available, _git_binary_failure

    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "--version",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        _mark_unavailable("not_found", str(exc)[:200])
        return
    except Exception as exc:  # noqa: BLE001 — probe must never break startup
        _mark_unavailable(type(exc).__name__, str(exc)[:200])
        return

    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), _GIT_PROBE_TIMEOUT)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        _mark_unavailable("probe_timeout", f"git --version > {_GIT_PROBE_TIMEOUT}s")
        return
    except Exception as exc:  # noqa: BLE001 — probe must never break startup
        _mark_unavailable(type(exc).__name__, str(exc)[:200])
        return

    if proc.returncode != 0:
        detail = stdout.decode(errors="replace").strip()[:200]
        _mark_unavailable("nonzero_exit", detail or f"exit={proc.returncode}")
        return

    _git_binary_available = True
    _git_binary_failure = None
    logger.debug("git.binary_ok", version=stdout.decode(errors="replace").strip()[:80])


def _mark_unavailable(reason: str, detail: str) -> None:
    global _git_binary_available, _git_binary_failure
    _git_binary_available = False
    _git_binary_failure = (reason, detail or None)
    logger.warning(
        "git.binary_unavailable",
        reason=reason,
        detail=detail or None,
        hint="服务端 git 工具与「从 GitHub 克隆」将不装配，直到镜像/PATH 提供 git",
    )
