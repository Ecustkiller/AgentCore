"""Shared test fixtures + tmp-dir strategy.

The ``pytest_configure`` hook here is the single owner of pytest's temp-dir location
(``pyproject.toml`` deliberately sets NO ``--basetemp``). See the hook docstring for
the Windows WinError 5 traps it dodges.
"""

import os
import shutil
import stat
import sys
import tempfile
import time
import uuid
from pathlib import Path

import pytest

# A stale per-session tmp dir is reaped only once it is older than this — long past any
# real test session, so a concurrently-running pytest (parallel agents / xdist, per the
# integration conftest) never has its LIVE basetemp deleted out from under it.
_TMP_PREFIX = "agentcore_pytest_"
_TMP_REAP_AGE_S = 6 * 3600


def _rmtree_quiet(path: Path) -> None:
    """Recursively delete ``path``; NEVER raise.

    Clears the read-only bit first (git objects inside a workspace fixture are read-only
    on Windows, so rmtree's default handler raises WinError 5 on them) and swallows
    anything else — a dir a leaked subprocess still holds is in Windows "delete-pending"
    limbo and cannot be removed until that handle closes, so we skip it and let a later
    session reap it once the holder dies.
    """

    def _retry(func, target, _exc):  # noqa: ANN001 - shutil callback shape
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except OSError:
            pass

    try:
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=_retry)
        else:  # pragma: no cover - project runs on 3.13
            shutil.rmtree(path, onerror=lambda f, p, _e: _retry(f, p, None))
    except OSError:
        pass


def pytest_configure(config: pytest.Config) -> None:
    """Route pytest's tmp dirs to a unique-per-session folder under the OS temp dir.

    Two Windows WinError 5 traps motivate this — both turned a fully-passing run into a
    non-zero exit spamming ``PermissionError`` during cleanup:

    * The DEFAULT auto-numbered base (``<tmp>/pytest-of-<user>/``) keeps a
      ``pytest-current`` symlink whose cleanup throws (symlink stat denied).
    * A FIXED shared ``--basetemp`` (the previous workaround) is ``rm_rf``-reset at
      session START, *unsuppressed* — so the moment a prior run leaks a file handle (a
      ``SubprocessSandbox`` child whose CWD is the tmp workspace puts that dir into
      "delete-pending"), the next run's reset raises on every undeletable entry.

    A unique basetemp per session never needs a pre-run reset (a fresh path has nothing
    to delete), and pytest does not auto-clean an *explicit* basetemp at session end —
    so no ``rm_rf`` ever runs against a directory another live process might be holding.
    Leftovers land in TEMP (OS-reclaimed), never the repo. An explicit CLI
    ``--basetemp`` still wins (the guard below).
    """
    if config.option.basetemp:
        return
    root = Path(tempfile.gettempdir())
    # Self-maintaining: reap our OWN stragglers from past runs, but only ones old enough
    # that no concurrent session could still be using them (suppressed end-to-end).
    now = time.time()
    for stale in root.glob(f"{_TMP_PREFIX}*"):
        try:
            if now - stale.stat().st_mtime < _TMP_REAP_AGE_S:
                continue
        except OSError:
            continue
        _rmtree_quiet(stale)
    config.option.basetemp = str(
        root / f"{_TMP_PREFIX}{os.getpid()}_{uuid.uuid4().hex[:8]}"
    )


@pytest.fixture
def anyio_backend():
    return "asyncio"
