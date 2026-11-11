"""Per-fan-out shared-prefix warm gate.

One ``WaveScheduler`` instance is one fan-out. Its workers all open on the same
frozen system + tools prefix and differ only in the tail of the opening user
card. A cache entry exists only after some request has run its prefill: implicit
prefix caching (DeepSeek / OpenAI automatic) or an Anthropic ``/messages``
explicit breakpoint. This gate lets one worker go first and holds the rest until
that leader's first streamed chunk (prefill done, cache written), so the
followers open on a warm prefix: ``N x prefill`` collapses to
``1 x prefill + N x tail``.

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


@dataclass(frozen=True)
class WarmGatePolicy:
    window: float
    anthropic_only: bool


@dataclass
class PrefixWarmGate:
    window: float
    _claimed: bool = False
    _warmed: asyncio.Event = field(default_factory=asyncio.Event)
    # ``None`` settings default: only Anthropic-Messages workers participate.
    # An explicit window keeps the legacy all-provider opt-in.
    anthropic_only: bool = False

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


def request_uses_anthropic_messages(llm: object, model: str) -> bool:
    """Resolve the worker's route key against the leaf that will send its wire."""
    from agentcore.llm.byok_provider_presets import anthropic_messages_dialect

    resolver = getattr(llm, "resolve_route", None)
    if callable(resolver):
        leaf, leaf_model = resolver(model)
        base_url = getattr(leaf, "base_url", None)
        return anthropic_messages_dialect(
            model_id=str(leaf_model),
            base_url=str(base_url) if base_url else None,
        )
    base_url = getattr(llm, "base_url", None)
    return anthropic_messages_dialect(
        model_id=model,
        base_url=str(base_url) if base_url else None,
    )


async def wait_for_shared_prefix(*, anthropic_messages: bool | None = None) -> bool:
    """Gate this task's FIRST eligible llm call in a fan-out. True for the leader.

    A dialect-scoped default gate lets non-Anthropic workers through without
    claiming leadership or waiting; an explicit window still gates every worker.
    The leader must call :func:`mark_shared_prefix_warmed` when its first
    streamed chunk lands and on every terminal path. Followers wait at most
    ``window`` seconds. No gate / already consulted ⇒ False, no wait.
    """
    gate = current_prefix_warm_gate()
    if gate is None or _consulted_gate.get() is gate:
        return False
    if gate.anthropic_only and not anthropic_messages:
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


def warm_gate_policy() -> WarmGatePolicy:
    """Resolve the one scheduler-owned gate policy from explicit settings."""
    try:
        from agentcore.config.settings import settings

        explicit = settings.engine_prefix_warm_window_seconds
        return WarmGatePolicy(
            window=settings.resolve_prefix_warm_window_seconds(anthropic_messages=True),
            anthropic_only=explicit is None,
        )
    except Exception:  # noqa: BLE001 — settings unavailable ⇒ feature off
        return WarmGatePolicy(window=0.0, anthropic_only=False)


def warm_window_seconds() -> float:
    """Read lazily so ``runs`` stays importable without an initialised settings object."""
    return warm_gate_policy().window
