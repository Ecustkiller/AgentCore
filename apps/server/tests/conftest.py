"""Shared test fixtures + tmp-dir strategy.

The ``pytest_configure`` hook here is the single owner of pytest's temp-dir location
(``pyproject.toml`` deliberately sets NO ``--basetemp``). See the hook docstring for
the Windows WinError 5 traps it dodges.
"""

import contextlib
import os
import shutil
import stat
import tempfile
import time
import uuid
from pathlib import Path

os.environ["LOG_LEVEL"] = "WARNING"

import pytest

# A stale per-session tmp dir is reaped only once it is older than this — long past any
# real test session, so a concurrently-running pytest (parallel agents / xdist, per the
# integration conftest) never has its LIVE basetemp deleted out from under it.
_TMP_PREFIX = "agentcore_pytest_"
_TMP_REAP_AGE_S = 6 * 3600


@pytest.fixture(autouse=True)
def _mark_test_traffic():
    """Tag all pytest log lines as synthetic (``traffic=test``); restore on teardown.

    Real user traffic never binds ``traffic`` — absence means production. Scoped via
    ``log_context`` so the key cannot leak into a later test's assertions.
    """
    from agentcore.core.log_context import log_context

    with log_context(traffic="test"):
        yield


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

    with contextlib.suppress(OSError):
        shutil.rmtree(path, onexc=_retry)


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
    config.option.basetemp = str(root / f"{_TMP_PREFIX}{os.getpid()}_{uuid.uuid4().hex[:8]}")


@pytest.fixture
def anyio_backend():
    return "asyncio"


class LogSpy:
    """A drop-in replacement for a module's structlog ``logger`` that records every
    ``logger.info`` / ``.warning`` / ``.error`` / ``.debug`` call as ``(event, kwargs)``.

    Use via ``monkeypatch.setattr(some_module, "logger", LogSpy())`` to assert on a
    structured log line's FIELDS deterministically. This is the reliable alternative to
    ``structlog.testing.capture_logs`` here: ``cache_logger_on_first_use=True`` (core/
    logging.py) caches a module logger's bound methods on first use, so once an earlier
    test has exercised a module's logger, ``capture_logs`` no longer intercepts it. Swapping
    the module attribute sidesteps that entirely (config- and order-independent). Same idiom
    as ``test_source_domains._LogSpy``, hoisted here for the decision-observability tests.
    """

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def _record(self, event: str, *args: object, **kwargs: object) -> None:
        self.events.append((event, dict(kwargs)))

    info = _record
    warning = _record
    error = _record
    debug = _record

    def get(self, event: str) -> dict:
        """Return the kwargs of the one logged ``event`` (asserts exactly one was logged)."""
        matches = [kw for name, kw in self.events if name == event]
        assert len(matches) == 1, (
            f"expected exactly one {event!r} log, got {len(matches)} "
            f"(events: {[n for n, _ in self.events]})"
        )
        return matches[0]
