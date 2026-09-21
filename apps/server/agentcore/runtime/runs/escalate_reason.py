"""Shared escalate reason: wait | scope | dep. 无法识别则 wait。"""

from __future__ import annotations

ESCALATE_REASONS = frozenset({"wait", "scope", "dep"})


def parse_escalate_reason(raw: object) -> str:
    """Tool / transcript 共用。不读旧参数 blocking/kind。"""
    reason = str(raw or "wait").strip().lower()
    return reason if reason in ESCALATE_REASONS else "wait"
