"""Per-fan-out shared-prefix warm gate.

One ``WaveScheduler`` instance is one fan-out. Its workers all open on the same
frozen system + tools prefix and differ only in the tail of the opening user
card. With implicit provider prefix caching (DeepSeek / OpenAI automatic), a
cache entry exists only after some request has run its prefill — N workers
launched in the same event-loop tick therefore all miss and each pays a full
prefill. This gate lets one worker go first and holds the rest until that
leader's first streamed chunk (prefill done, cache written), so the followers
open on a warm prefix: ``N x prefill`` collapses to ``1 x prefill + N x tail``.

Fail-open by construction: the wait is bounded by ``window``, and the leader
releases the gate on every terminal path (first chunk, error, cancel). A
leader that dies cannot strand followers.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from contextvars import ContextVar, Token
from dataclasses import dataclass, field

_gate: ContextVar[PrefixWarmGate | None] = ContextVar(
    "agentcore_prefix_warm_gate", default=None
)
# Which gate this task already consulted. Identity comparison (not a bool) so a
# nested fan-out's own gate is consulted even though the parent worker already
# went through its first round.
_consulted_gate: ContextVar[object | None] = ContextVar(
    "agentcore_prefix_warm_consulted", default=None
)


@dataclass
class PrefixWarmGate:
    window: float
    _claimed: bool = False
    _warmed: asyncio.Event = field(default_factory=asyncio.Event)

    def claim_leader(self) -> bool:
        """First caller in this fan-out becomes the cache warmer.

        Sync (no await between test and set) — atomic on the event loop.
        """
        if self._claimed:
            return False
        self._claimed = True
        return True

    def mark_warmed(self) -> None:
        self._warmed.set()

    @property
    def warmed(self) -> bool:
        return self._warmed.is_set()

    async def wait_for_warm(self) -> None:
        """Follower wait. Times out to the current behaviour, never raises on timeout."""
        if self._warmed.is_set():
            return
        with suppress(TimeoutError):
            await asyncio.wait_for(self._warmed.wait(), self.window)


def bind_prefix_warm_gate(gate: PrefixWarmGate | None) -> Token:
    return _gate.set(gate)


def reset_prefix_warm_gate(token: Token) -> None:
    _gate.reset(token)


def current_prefix_warm_gate() -> PrefixWarmGate | None:
    return _gate.get()


async def wait_for_shared_prefix() -> bool:
    """Gate this task's FIRST llm call in a fan-out. Returns True for the leader.

    The leader must call :func:`mark_shared_prefix_warmed` when its first
    streamed chunk lands (prefill done) and on every terminal path. Followers
    wait at most ``window`` seconds. No gate / already consulted ⇒ False, no
    wait — so captain calls, later ReAct rounds, and background one-shots are
    untouched.
    """
    gate = current_prefix_warm_gate()
    if gate is None or _consulted_gate.get() is gate:
        return False
    _consulted_gate.set(gate)
    if gate.claim_leader():
        return True
    await gate.wait_for_warm()
    return False


def mark_shared_prefix_warmed() -> None:
    gate = current_prefix_warm_gate()
    if gate is not None:
        gate.mark_warmed()


def warm_window_seconds() -> float:
    """Opt-in knob. 0 (default) leaves the whole feature inert.

    Read lazily so ``runs`` stays importable without an initialised settings
    object (matches ``concurrency.resolve_max_parallel``).
    """
    try:
        from agentcore.config.settings import settings

        return max(0.0, float(settings.engine_prefix_warm_window_seconds))
    except Exception:  # noqa: BLE001 — settings unavailable ⇒ feature off
        return 0.0
