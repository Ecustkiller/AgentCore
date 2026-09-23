"""User-turn cumulative LLM **cost** ceiling (R-01 费用护栏 · 与 token 顶正交).

计量：一个用户回合内所有 LLM 调用的已计价费用（CEO + 全树 worker + 续派 / 辩论）。
口径：``billed_nano`` = platform/vendor 的 ``cost_total_nano``（配额/计费面），
``estimated_nano`` = BYOK ``cost_estimated_nano``（用户自付估计，单独累计、**不入顶**）——
与 :mod:`agentcore.costing.split_cost` 的 billed/estimated 二分完全一致，金额口径不漂移。

计价唯一真源：:func:`agentcore.llm.observability.log_llm_call` 已用
:func:`agentcore.llm.pricing.calculate_cost` 单点计价（不变量 #2），本模块**不复价**，只把
该处已算好的 ``cost_nano`` / ``cost_estimated_nano`` 累进 ContextVar meter——与
``record_turn_tokens`` 走同一个 emit 缝，token 顶/成本顶永远同源同步。

护栏语义（两段式，对齐 :mod:`agentcore.runtime.turn.token_budget`）：
1. **软闸**（delivery reserve）：累计 billed ≥ ceiling − reserve 时，仅放行
   ``ceiling_priority`` 节点，次要节点软跳过（先收敛工具/提示）；
2. **硬顶**：累计 billed ≥ ceiling 时，禁新 delegate/debate/新波派发，在飞跑完不 cancel，
   注入一次性 CEO 收口 steer（再收口）。

持久化：本模块只管**实时进程内**计量与闸门；回合收尾时聚合费用照旧经
:func:`agentcore.billing.turn_ledger.reconcile_turn_cost_ledger` 物化进 ``cost_events``
（billable 权威账），触顶/跳过事件经 ``delegate.turn_cost_ceiling_skip`` / ``cost.*``
日志可见。与 per-worker ``engine_worker_token_ceiling`` 正交；无 USD / tier 换算、无
CEO override、不 cancel 在飞任务。
"""

from __future__ import annotations

import threading
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any

# delivery_status.gaps.reason — 成本护栏跳过 / 收口缺口（非软验收路径）
REASON_TURN_COST_BUDGET = "turn_cost_budget"

TURN_COST_CEILING_WARNING = "本回合累计费用已触顶，未派发节点已跳过；请基于已完成产出收口"

TURN_COST_RESERVE_SKIP_WARNING = "本回合进入费用交付预留窗口，次要节点已跳过以为验收节点留量"


@dataclass
class TurnCostMeter:
    """Mutable turn-scoped cost counter (task-local via ContextVar).

    ``billed_nano`` drives the ceiling; ``estimated_nano`` (BYOK) is tracked for
    observability only and never gates — it is the user's own out-of-pocket spend,
    not quota/billing money.
    """

    billed_nano: int = 0
    estimated_nano: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def add(self, billed_nano: int, estimated_nano: int) -> None:
        billed = int(billed_nano or 0)
        estimated = int(estimated_nano or 0)
        if billed > 0 or estimated > 0:
            with self._lock:
                self.billed_nano += billed
                self.estimated_nano += estimated


_meter: ContextVar[TurnCostMeter | None] = ContextVar("turn_cost_meter", default=None)


def bind_turn_cost_meter(*, seed_billed: int = 0, seed_estimated: int = 0) -> Token[TurnCostMeter | None]:
    """Install a fresh cost meter for this user turn; returns reset token."""
    return _meter.set(
        TurnCostMeter(
            billed_nano=max(0, int(seed_billed)),
            estimated_nano=max(0, int(seed_estimated)),
        )
    )


def reset_turn_cost_meter(token: Token[TurnCostMeter | None]) -> None:
    _meter.reset(token)


def record_turn_cost(billed_nano: int, estimated_nano: int) -> None:
    """Accumulate priced cost when a turn meter is bound (no-op off-turn / background)."""
    meter = _meter.get()
    if meter is None:
        return
    meter.add(billed_nano, estimated_nano)


def current_turn_cost_nano() -> int:
    """Billable (quota/billing) cost spent so far this turn, in nano."""
    meter = _meter.get()
    return meter.billed_nano if meter is not None else 0


def current_turn_cost_estimated_nano() -> int:
    """BYOK estimated cost spent so far this turn (never gates), in nano."""
    meter = _meter.get()
    return meter.estimated_nano if meter is not None else 0


def resolve_turn_cost_ceiling_nano() -> int:
    """Configured billable cost hard ceiling; ≤0 disables. Settings missing → 0 (off)."""
    try:
        from agentcore.config import settings

        return int(settings.engine_turn_cost_ceiling_nano)
    except Exception:  # noqa: BLE001 — settings optional in unit stubs
        return 0


def resolve_turn_cost_delivery_reserve_nano() -> int:
    """Absolute billable headroom for ``ceiling_priority`` tails; ≤0 disables reserve."""
    try:
        from agentcore.config import settings

        return int(settings.engine_turn_cost_delivery_reserve_nano)
    except Exception:  # noqa: BLE001 — settings optional in unit stubs
        return 0


def is_turn_cost_ceiling_hit() -> bool:
    ceiling = resolve_turn_cost_ceiling_nano()
    if ceiling <= 0:
        return False
    return current_turn_cost_nano() >= ceiling


def is_turn_cost_delivery_reserve_hit() -> bool:
    """True when billable spend has entered the cost delivery-reserve window.

    ``reserve <= 0`` or ``reserve >= ceiling`` → off (same pathology rule as token
    budget). Hard ceiling alone still governs full stop.
    """
    ceiling = resolve_turn_cost_ceiling_nano()
    reserve = resolve_turn_cost_delivery_reserve_nano()
    if ceiling <= 0 or reserve <= 0 or reserve >= ceiling:
        return False
    spent = current_turn_cost_nano()
    if spent >= ceiling:
        return False  # hard ceiling owns the stop; reserve soft-gate is moot
    return spent >= (ceiling - reserve)


def turn_cost_ceiling_reject_message() -> str:
    ceiling = resolve_turn_cost_ceiling_nano()
    spent = current_turn_cost_nano()
    return (
        f"本回合累计费用已达上限（已计费 {_nano_cny(spent)} / 上限 {_nano_cny(ceiling)}），"
        "禁止新开派单；请基于已完成产出收口。"
        "下一回合可续跑本图未跑节点（append 同图 / replan 点名），禁止假装已全部完成。"
    )


def turn_cost_budget_wrap_prompt() -> str:
    """CEO one-shot ``[系统提示]``：费用触顶后基于已有产出收口（禁假完成 / 禁再派）。"""
    ceiling = resolve_turn_cost_ceiling_nano()
    spent = current_turn_cost_nano()
    return (
        f"[系统提示] 本回合累计费用已触顶（已计费 {_nano_cny(spent)} / 上限 {_nano_cny(ceiling)}）。"
        "本回合禁止乱开新派单与新辩论；在飞任务结束后请立即基于已完成产出向用户收口——"
        "汇总已有结论与落盘文件，并显式标出未完成缺口"
        f"（gap 原因可用 `{REASON_TURN_COST_BUDGET}`）。"
        "**下一回合可续跑本图因额度未跑的节点**（append 同图 / replan 点名角色）；"
        "禁止假装本回合已全部完成。"
        "禁止再尝试无关的新 delegate/debate；禁止空转探路；禁止把部分完成伪装成全部交付。"
    )


def _nano_cny(nano: int) -> str:
    """Human-readable CNY from integer nano (defensive; 1 CNY = 1e9 nano)."""
    try:
        return f"¥{nano / 1_000_000_000:.4f}"
    except Exception:  # noqa: BLE001 — formatting must never break the gate
        return f"{nano} nano"


def cost_from_journal_entries(entries: list[dict[str, Any]] | None) -> tuple[int, int]:
    """Best-effort ``(billed, estimated)`` seed from a journal's ``run_completed`` facts.

    The ``llm_call`` fact carries only token usage; per-run money rides the
    ``run_completed`` event's ``cost.total`` (nano) + ``cost.credential_source``.
    Missing / malformed rows contribute 0 — the meter still guards new spend from
    this point onward (never silently over-credits).
    """
    billed = 0
    estimated = 0
    for entry in entries or []:
        if not isinstance(entry, dict) or entry.get("kind") != "run_completed":
            continue
        payload = entry.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        cost = payload.get("cost") or {}
        if not isinstance(cost, dict):
            continue
        total = int(cost.get("total") or 0)
        if total <= 0:
            continue
        if str(cost.get("credential_source") or "") == "user":
            estimated += total
        else:
            billed += total
    return billed, estimated
