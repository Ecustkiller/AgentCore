"""Per-host egress circuit breaker for direct-egress web tools.

The stateless networking primitives (timeouts, :func:`describe_net_error`,
:func:`site_of`, the SSRF guard) moved to :mod:`agentcore.core.net` so HTTP
routes (e.g. the favicon proxy) can reuse them without importing ``tools``.
This module keeps only the *stateful* part — a best-effort, in-process per-host
breaker — and re-exports the core primitives so existing
``from ...web._net import ...`` call sites keep working unchanged.

``read_url`` reaches the open internet directly via httpx (unlike ``web_search``,
which is proxied through a self-hosted SearXNG). In restricted-egress
environments a blocked host wastes the full timeout on *every* retry across
ReAct rounds; the breaker short-circuits a host after repeated transport
failures so the agent fast-fails (raising :class:`EgressError`) instead of
stalling, then auto-recovers after a cooldown.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from agentcore.core.net import (
    SEARCH_TIMEOUT,
    WEB_CONNECT_TIMEOUT,
    WEB_READ_TIMEOUT,
    EgressError,
    PinnedAddressError,
    PinnedIPTransport,
    describe_net_error,
    site_of,
    web_timeout,
)

__all__ = [
    "SEARCH_TIMEOUT",
    "WEB_CONNECT_TIMEOUT",
    "WEB_READ_TIMEOUT",
    "WEB_HOST_FAIL_THRESHOLD",
    "WEB_HOST_CIRCUIT_COOLDOWN",
    "EgressError",
    "PinnedAddressError",
    "PinnedIPTransport",
    "circuit_remaining",
    "describe_net_error",
    "note_failure",
    "note_success",
    "site_of",
    "web_timeout",
]

WEB_HOST_FAIL_THRESHOLD = 3  # consecutive transport failures before tripping
WEB_HOST_CIRCUIT_COOLDOWN = 120.0  # how long a tripped host stays short-circuited


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
