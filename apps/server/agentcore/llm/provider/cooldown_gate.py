"""Process-wide 429 cooldown, keyed by provider + credential + lane.

After an upstream 429 the leaf arms a slot until ``recovery_at``. Later calls on
the same key refuse immediately (no sleep, no upstream probe) instead of each
independently slamming the same window. The call that received an attested
short ``Retry-After`` may still sit that wait out in-place; siblings do not.

最后修订 2026-11-04：槽表改为可替换后端（``cache/shared_state.py``）。默认
``memory`` 与改造前逐位等价；opt-in ``redis`` 只把「已武装」这件事共享出去，
**不改变多 worker 拒启口径**，也不宣称多机就绪 —— 见 ``config/shared_state.py``。

In-process only by default — the same posture as compaction's failure cooldown.
Multi-worker skew is accepted upstream: two API processes may each probe once,
which is still fewer than every in-flight worker + CEO racing the same Retry-After.
The Redis backend tightens (not changes) that posture.

Interactive chat / agent share one lane (worker 429 must still stop the CEO
slamming the same window). Each background scenario (title, compaction, …) has
its own lane so a title day-reset Retry-After cannot make compaction refuse
before it probes.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass

from agentcore.cache.shared_state import (
    CooldownStore,
    StoredSlot,
    build_cooldown_store,
)
from agentcore.llm.provider.protocol import TURN_SCALE_SCENARIOS

# Interactive chat / agent share this lane. Background one-shots use the scenario
# name so a title day-reset cannot occupy compaction's slot.
TURN_COOLDOWN_LANE = "turn"

# Short cooldowns the interactive leaf sits out silently (chat / agent). Past
# this, the call fails immediately and the layer above reads ``failure_class``
# to decide wait-and-resume vs fail the node. Env override is for dogfood, not
# a product setting — user-facing copy still keys off ``MAX_RETRY_AFTER``.
SILENT_COOLDOWN_SECONDS = 10.0
_SILENT_COOLDOWN_ENV = "AGENTCORE_LLM_SILENT_COOLDOWN_SECONDS"


@dataclass(frozen=True, slots=True)
class CooldownSlot:
    """One armed window. ``seconds`` / ``source`` are whose number it is."""

    recovery_at: float
    seconds: float
    source: str


_STORE: CooldownStore | None = None


def _store() -> CooldownStore:
    global _STORE
    if _STORE is None:
        _STORE = build_cooldown_store()
    return _STORE


def _clock(now: float | None) -> float:
    """单调时钟；每个公开函数只取一次，Memory 与 Redis 共用同一基准。"""
    return time.monotonic() if now is None else now


def override_cooldown_store(store: CooldownStore | None) -> None:
    """Tests: inject a store (``None`` restores lazy construct)."""
    global _STORE
    _STORE = store


def silent_cooldown_seconds() -> float:
    """Longest cooldown an interactive turn will sit out without bubbling up."""
    raw = os.environ.get(_SILENT_COOLDOWN_ENV, "").strip()
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = SILENT_COOLDOWN_SECONDS
        else:
            if value >= 0.0:
                return value
    return SILENT_COOLDOWN_SECONDS


def cooldown_key(provider: str, credential: str, base_url: str) -> str:
    """Stable id for a leaf. Hashes the secret so the map never stores a key."""
    material = f"{provider}\0{base_url}\0{credential}".encode()
    digest = hashlib.sha256(material).hexdigest()[:16]
    return f"{provider}:{digest}"


def cooldown_lane(scenario: str) -> str:
    """Lane for ``scenario``: one shared turn slot, otherwise the scenario name."""
    if scenario in TURN_SCALE_SCENARIOS:
        return TURN_COOLDOWN_LANE
    name = (scenario or "").strip()
    return name or "unknown"


def cooldown_slot_key(provider_key: str, scenario: str) -> str:
    """Process slot id: credential key plus :func:`cooldown_lane`."""
    return f"{provider_key}:{cooldown_lane(scenario)}"


def peek_cooldown(key: str, *, now: float | None = None) -> CooldownSlot | None:
    """The live slot, or ``None`` when open / expired (expired slots are dropped)."""
    t = _clock(now)
    stored = _store().get(key, now=t)
    if stored is None:
        return None
    return CooldownSlot(
        recovery_at=t + stored.remaining,
        seconds=stored.seconds,
        source=stored.source,
    )


def cooldown_remaining(key: str, *, now: float | None = None) -> float:
    """Seconds until the slot opens. ``0.0`` when the key is free."""
    t = _clock(now)
    stored = _store().get(key, now=t)
    return stored.remaining if stored is not None else 0.0


def arm_cooldown(key: str, seconds: float, source: str, *, now: float | None = None) -> None:
    """Arm or extend the slot. Never shortens an already-later ``recovery_at``."""
    if seconds <= 0:
        return
    t = _clock(now)
    store = _store()
    existing = store.get(key, now=t)
    if existing is not None and existing.remaining >= seconds:
        return
    store.set(key, StoredSlot(remaining=seconds, seconds=seconds, source=source), now=t)


def clear_cooldown(key: str) -> None:
    """Drop the slot — success, or this caller already sat the wait out."""
    _store().clear(key)


def reset_cooldown_gate() -> None:
    """Tests only: drop every slot so a leaked day-reset cannot starve the next case."""
    global _STORE
    if _STORE is not None:
        _STORE.reset()
    _STORE = None
