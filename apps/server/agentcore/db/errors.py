"""Classify DB exceptions so best-effort background sweeps log loudly on real faults.

A schema / programming error (missing table or column, malformed SQL) is a
PERSISTENT misconfiguration — almost always a pending migration — not a transient
blip. The periodic retention / consolidation sweeps are best-effort (a failure must
not kill the loop), but a *whole background task silently failing every interval*
deserves ``error`` so a watchdog catches it; an ordinary transient DB hiccup stays
``warning`` (the next interval will likely clear it).

Connectivity / unreachable faults (connection refused, WinError 1225, …) are a
separate class: callers that must not invent offline fallbacks raise
``DatabaseUnavailableError`` with a stable user-facing message.

→ 见: conversation-logs.mdc「找优化点」/ logging.mdc 事件分级
"""

from __future__ import annotations

import errno

from sqlalchemy.exc import InterfaceError, OperationalError, ProgrammingError

# Stable user-facing copy for tools / sidecar / delegate — prefer this over raw
# WinError / OSError text. Dev logs keep the underlying cause via ``__cause__``.
DATABASE_UNAVAILABLE_MESSAGE = "AgentCore 服务暂时不可用，请稍后重试"
# ToolResult.error / structured prepare codes (not OS / driver prose).
DATABASE_UNAVAILABLE_CODE = "database_unavailable"


class DatabaseUnavailableError(RuntimeError):
    """Raised when the database cannot be reached (honest fail; no offline invent)."""

    def __init__(self, message: str = DATABASE_UNAVAILABLE_MESSAGE) -> None:
        super().__init__(message)


def is_schema_error(exc: BaseException) -> bool:
    """True if ``exc`` is a DB schema / programming fault (undefined table/column,
    bad SQL) — a persistent misconfiguration to surface at ``error``, vs a transient
    operational failure to log at ``warning``."""
    return isinstance(exc, ProgrammingError)


def _is_connectivity_leaf(exc: BaseException) -> bool:
    if isinstance(exc, (ConnectionRefusedError, ConnectionError, TimeoutError)):
        return True
    if isinstance(exc, (OperationalError, InterfaceError)):
        return True
    if isinstance(exc, OSError):
        winerror = getattr(exc, "winerror", None)
        # 1225 = ERROR_CONNECTION_REFUSED; 10061 = WSAECONNREFUSED
        if winerror in {1225, 10061}:
            return True
        if getattr(exc, "errno", None) in {
            errno.ECONNREFUSED,
            errno.ENETUNREACH,
            errno.EHOSTUNREACH,
            errno.ETIMEDOUT,
        }:
            return True
    return False


def is_db_connectivity_error(exc: BaseException) -> bool:
    """True when ``exc`` (or its cause chain / SQLAlchemy ``orig``) is DB unreachable.

    Used to rewrite opaque system errors (e.g. WinError 1225) into
    ``DatabaseUnavailableError`` — not for inventing offline project caches.
    """
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if _is_connectivity_leaf(cur):
            return True
        orig = getattr(cur, "orig", None)
        if isinstance(orig, BaseException) and id(orig) not in seen:
            cur = orig
            continue
        cur = cur.__cause__ or cur.__context__
    return False


def reraise_as_database_unavailable(exc: BaseException) -> None:
    """If ``exc`` is a connectivity fault, raise ``DatabaseUnavailableError`` from it.

    Non-connectivity exceptions are left alone (caller should ``raise``).
    """
    if isinstance(exc, DatabaseUnavailableError):
        raise exc
    if is_db_connectivity_error(exc):
        raise DatabaseUnavailableError(DATABASE_UNAVAILABLE_MESSAGE) from exc
