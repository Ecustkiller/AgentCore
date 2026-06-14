"""Shared networking resilience for direct-egress web tools.

``read_url`` reaches the open internet directly via httpx (unlike ``web_search``,
which is proxied through a self-hosted SearXNG). In restricted-egress
environments a blocked host wastes the full timeout on *every* retry across
ReAct rounds, and httpx's ``ConnectTimeout`` stringifies to ``""`` — so the
failure is both slow and invisible in logs.

This module is the shared remedy, wired in at the common choke point
(``read_url._safe_request``):

- :func:`describe_net_error` — turn opaque httpx errors into an honest,
  model-facing reason (so logs show the real cause, not ``error: ""``).
- a per-host **circuit breaker** (:func:`circuit_remaining` / :func:`note_failure`
  / :func:`note_success`) — after repeated transport failures a host is
  short-circuited for a cooldown, so the agent fast-fails instead of stalling.
- :func:`web_timeout` — a shared ``httpx.Timeout`` with a short connect deadline
  (blocked hosts fail fast) and a longer read window (slow sites still succeed).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

SEARCH_TIMEOUT = 10.0
WEB_CONNECT_TIMEOUT = 5.0  # connect deadline: blocked hosts fail fast
WEB_READ_TIMEOUT = 15.0  # read window for slow-but-reachable sites
WEB_HOST_FAIL_THRESHOLD = 3  # consecutive transport failures before tripping
WEB_HOST_CIRCUIT_COOLDOWN = 120.0  # how long a tripped host stays short-circuited


class EgressError(Exception):
    """Raised when the per-host breaker short-circuits an outbound request.

    Its ``str()`` is the honest, model-facing reason, so callers can surface it
    directly without re-wrapping.
    """


def web_timeout(read: float = WEB_READ_TIMEOUT) -> httpx.Timeout:
    """Timeout with a short connect deadline and a configurable read window."""
    return httpx.Timeout(read, connect=WEB_CONNECT_TIMEOUT)


def site_of(url: str) -> str:
    """Display hostname for a URL: lowercased, sans a leading ``www.``.

    Used to label source/citation cards. Returns ``""`` when the URL has no
    parseable host (the card then falls back to the title/url).
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def describe_net_error(e: BaseException) -> str:
    """Readable reason for a failed outbound request.

    httpx timeout/connect errors frequently stringify to ``""``; surface the
    failure type plus a plain-language hint so both the log and the model see a
    real cause instead of an empty string.
    """
    if isinstance(e, EgressError):
        return str(e)
    if isinstance(e, httpx.ConnectTimeout):
        return "连接超时（无法连上该站点，可能出网受限或站点不可达）"
    if isinstance(e, httpx.ReadTimeout):
        return "读取超时（站点响应过慢）"
    if isinstance(e, (httpx.ConnectError, httpx.NetworkError)):
        detail = str(e).strip()
        return "无法建立连接（出网受限或站点不可达）" + (f": {detail}" if detail else "")
    if isinstance(e, httpx.TimeoutException):
        return "请求超时"
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTP {e.response.status_code}"
    detail = str(e).strip()
    return f"{type(e).__name__}" + (f": {detail}" if detail else "")


@dataclass
class _HostState:
    fails: int = 0
    open_until: float = 0.0


# Best-effort, in-process breaker. Single event loop → plain dict mutations are
# safe enough; state is intentionally ephemeral (resets on restart).
_states: dict[str, _HostState] = {}


def circuit_remaining(host: str) -> float:
    """Seconds the breaker stays open for ``host`` (``0.0`` = closed/allowed)."""
    st = _states.get(host)
    if st is None:
        return 0.0
    return max(0.0, st.open_until - time.monotonic())


def note_success(host: str) -> None:
    """Clear a host's failure streak after a successful request."""
    _states.pop(host, None)


def note_failure(host: str) -> None:
    """Record a transport failure; trip the breaker at the configured threshold."""
    if not host:
        return
    st = _states.setdefault(host, _HostState())
    st.fails += 1
    if st.fails >= WEB_HOST_FAIL_THRESHOLD:
        st.open_until = time.monotonic() + WEB_HOST_CIRCUIT_COOLDOWN
