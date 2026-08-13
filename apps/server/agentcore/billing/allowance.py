"""一个账号「上游还认不认它」的世代号——变了，所有据此缓存的拒绝就作废。

An upstream 429 that dates its own recovery（「13 小时后再来」）is an answer about one
account at one moment: *this* key, *this* allowance. Callers cache that date so they
stop hammering a wall — compaction is the one that matters, it stops folding a chat
until the moment passes.

The trouble is the two facts that actually retire such an answer are account-level
while the caches are not: the user pastes a new BYOK key (a different upstream is
being asked now), or an operator raises the quota (the same upstream would answer
differently). A per-conversation cooldown cannot see either, so the user did the one
thing the error message told them to do — 接入自己的 key — and the chat stayed frozen
anyway, growing until it no longer fit.

This module is the join. Whoever changes what upstream would answer calls
:func:`invalidate_allowance`; whoever caches such an answer records
:func:`allowance_epoch` alongside it and drops the entry once the two differ. Pull,
not push — the caches stay unknown to the settings and admin code that retires them.

In-process, like every cache it invalidates (single-server posture, same as
compaction's cooldown maps): a restart clears both sides at once, which is also the
right answer. One small int per account that ever changed a key or a quota.
"""

from __future__ import annotations

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

_epochs: dict[str, int] = {}


def allowance_epoch(user_id: str) -> int:
    """Current epoch for ``user_id`` — store it next to anything upstream-dated."""
    return _epochs.get(user_id, 0)


def invalidate_allowance(user_id: str, *, reason: str) -> int:
    """Retire every cached upstream refusal for ``user_id``; returns the new epoch.

    ``reason`` names the change (``byok_provider_changed`` / ``quota_changed``) and
    rides the log line — a chat that resumes folding minutes after a key swap should
    be traceable to the swap.
    """
    epoch = _epochs.get(user_id, 0) + 1
    _epochs[user_id] = epoch
    logger.info(
        "billing.allowance_invalidated",
        user_id=user_id,
        reason=reason,
        epoch=epoch,
    )
    return epoch


def reset_allowance_epochs() -> None:
    """Drop all epochs (test isolation)."""
    _epochs.clear()
