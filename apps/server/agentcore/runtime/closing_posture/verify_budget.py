"""Outer-loop verify timeout latch + hollow in-progress rework.

test_run idle hang / disaster forced-stop → incomplete（进程已中止，非仍在跑）.
Symbol names keep ``verify_budget`` for import stability.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from .hollow import claims_hollow_in_progress

_turn_verify_budget_exhausted: ContextVar[bool] = ContextVar(
    "turn_verify_budget_exhausted", default=False
)


def note_verify_budget_exhausted() -> None:
    """Latch when test_run timed out incomplete（进程已中止，非仍在跑）."""
    _turn_verify_budget_exhausted.set(True)


def clear_verify_budget_exhausted() -> None:
    _turn_verify_budget_exhausted.set(False)


def turn_has_verify_budget_exhausted() -> bool:
    return bool(_turn_verify_budget_exhausted.get())


def _gap_text_looks_like_verify_timeout(text: str) -> bool:
    if "非仍在跑" not in text and "验证未完成" not in text:
        return False
    return (
        "预算耗尽" in text
        or "无响应" in text
        or "强制中止" in text
        or "灾难顶" in text
    )


def note_verify_budget_from_delivery(gaps: list[Any] | None = None) -> None:
    """Stamp latch from delivery_status gaps with reason=verify_budget（结构化真源）."""
    for gap in gaps or []:
        if not isinstance(gap, dict):
            if _gap_text_looks_like_verify_timeout(str(gap or "")):
                note_verify_budget_exhausted()
                return
            continue
        reason = str(gap.get("reason") or "").strip()
        if reason == "verify_budget":
            note_verify_budget_exhausted()
            return
        if _gap_text_looks_like_verify_timeout(str(gap.get("description") or "")):
            note_verify_budget_exhausted()
            return


def _verify_budget_hollow_rework(content: str) -> str | None:
    """Timeout latch：禁『仍在进行』空悬（不扩姿势 A 词表）."""
    text = content or ""
    if not text.strip() or not turn_has_verify_budget_exhausted():
        return None
    if claims_hollow_in_progress(text):
        return (
            "本回合外环验证已因无响应或强制中止而结束——"
            "禁止写『仍在进行 / 继续等待』；请标未取得验证结果、进程已中止与下一步"
            "（缩小范围 / 检查本机环境 / 拆命令重试）。真源=结构化缺口，不扫自由文。"
        )
    return None
