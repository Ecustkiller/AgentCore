"""Process-wide 429 cooldown, keyed by provider + credential.

After an upstream 429 the leaf arms a slot until ``recovery_at``. Later calls on
the same key refuse immediately (no sleep, no upstream probe) instead of each
independently slamming the same window. The call that received an attested
short ``Retry-After`` may still sit that wait out in-place; siblings do not.

In-process only — the same posture as compaction's failure cooldown. Multi-worker
skew is accepted: two API processes may each probe once, which is still fewer
than every in-flight worker + CEO racing the same Retry-After.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass

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


_slots: dict[str, CooldownSlot] = {}


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


def peek_cooldown(key: str, *, now: float | None = None) -> CooldownSlot | None:
    """The live slot, or ``None`` when open / expired (expired slots are dropped)."""
    slot = _slots.get(key)
    if slot is None:
        return None
    t = time.monotonic() if now is None else now
    if slot.recovery_at <= t:
        _slots.pop(key, None)
        return None
    return slot


def cooldown_remaining(key: str, *, now: float | None = None) -> float:
    """Seconds until the slot opens. ``0.0`` when the key is free."""
    slot = peek_cooldown(key, now=now)
    if slot is None:
        return 0.0
    t = time.monotonic() if now is None else now
    return max(slot.recovery_at - t, 0.0)


def arm_cooldown(key: str, seconds: float, source: str, *, now: float | None = None) -> None:
    """Arm or extend the slot. Never shortens an already-later ``recovery_at``."""
    if seconds <= 0:
        return
    t = time.monotonic() if now is None else now
    recovery_at = t + seconds
    existing = _slots.get(key)
    if existing is not None and existing.recovery_at >= recovery_at:
        return
    _slots[key] = CooldownSlot(recovery_at=recovery_at, seconds=seconds, source=source)


def clear_cooldown(key: str) -> None:
    """Drop the slot — success, or this caller already sat the wait out."""
    _slots.pop(key, None)


def reset_cooldown_gate() -> None:
    """Tests only: drop every slot so a leaked day-reset cannot starve the next case."""
    _slots.clear()
