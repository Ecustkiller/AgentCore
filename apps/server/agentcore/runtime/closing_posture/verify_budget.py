"""Verify-budget exhausted latch + hollow in-progress rework.

test_run hit verify-budget incomplete（进程已中止，非仍在跑）.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from .hollow import claims_hollow_in_progress

_turn_verify_budget_exhausted: ContextVar[bool] = ContextVar(
    "turn_verify_budget_exhausted", default=False
)


def note_verify_budget_exhausted() -> None:
    """Latch when test_run hit verify-budget incomplete（进程已中止，非仍在跑）."""
    _turn_verify_budget_exhausted.set(True)


def clear_verify_budget_exhausted() -> None:
    _turn_verify_budget_exhausted.set(False)


def turn_has_verify_budget_exhausted() -> bool:
    return bool(_turn_verify_budget_exhausted.get())


def note_verify_budget_from_delivery(gaps: list[Any] | None = None) -> None:
    """Stamp latch from delivery_status gaps with reason=verify_budget（结构化真源）."""
    for gap in gaps or []:
        if not isinstance(gap, dict):
            text = str(gap or "")
            if "预算耗尽" in text and ("非仍在跑" in text or "验证未完成" in text):
                note_verify_budget_exhausted()
                return
            continue
        reason = str(gap.get("reason") or "").strip()
        if reason == "verify_budget":
            note_verify_budget_exhausted()
            return
        desc = str(gap.get("description") or "")
        if "预算耗尽" in desc and ("非仍在跑" in desc or "验证未完成" in desc):
            note_verify_budget_exhausted()
            return


def _verify_budget_hollow_rework(content: str) -> str | None:
    """verify_budget 结构化 latch：禁『仍在进行』空悬（不扩姿势 A 词表）."""
    text = content or ""
    if not text.strip() or not turn_has_verify_budget_exhausted():
        return None
    if claims_hollow_in_progress(text):
        return (
            "本回合外环验证已预算耗尽并中止（verify_budget）——"
            "禁止写『仍在进行 / 继续等待』；请标验证未完成、进程已中止与下一步"
            "（缩小范围 / 换更快 check / 拆命令重试）。真源=结构化缺口，不扫自由文。"
        )
    return None
