"""Worker 掐断透明化 + 收尾窗口：原因码、文案与工具白名单。

正轨 token 撞顶 / 墙钟超时 / 降级交接 必须产生结构化原因码，贯通
``RunState.warnings`` → ``delivery_status.gaps.reason`` → CEO 综述强制提及。
收尾窗口在硬顶前把工具面收窄到落盘 + handoff，降低 ``degraded_synth``。
"""

from __future__ import annotations

# delivery_status.gaps.reason 口径（契约单源：Wire DeliveryGap.reason）
REASON_TOKEN_BUDGET = "token_budget"
REASON_WORKER_TIMEOUT = "worker_timeout"
REASON_DEGRADED_HANDOFF = "degraded_handoff"

CUTOFF_REASONS = frozenset(
    {REASON_TOKEN_BUDGET, REASON_WORKER_TIMEOUT, REASON_DEGRADED_HANDOFF}
)

# RunState.warnings / gap description 稳定文案（collect_worker_gaps 依文案反查 reason）
TOKEN_BUDGET_WARNING = "队员因 token 预算触顶被迫收口，产出可能不完整"
WORKER_TIMEOUT_WARNING = "队员运行超时（仅通知、未取消），交付可能缩水"
DEGRADED_HANDOFF_WARNING = "交接简报由引擎降级合成（worker 未提交合格 handoff）"

WARNING_TO_REASON: dict[str, str] = {
    TOKEN_BUDGET_WARNING: REASON_TOKEN_BUDGET,
    WORKER_TIMEOUT_WARNING: REASON_WORKER_TIMEOUT,
    DEGRADED_HANDOFF_WARNING: REASON_DEGRADED_HANDOFF,
}

REASON_TO_WARNING: dict[str, str] = {
    REASON_TOKEN_BUDGET: TOKEN_BUDGET_WARNING,
    REASON_WORKER_TIMEOUT: WORKER_TIMEOUT_WARNING,
    REASON_DEGRADED_HANDOFF: DEGRADED_HANDOFF_WARNING,
}

# 预算收尾窗口：累计 token ≥ ceiling × ratio 时进入落盘/handoff-only（默认 85%）
DEFAULT_TOKEN_WIND_DOWN_RATIO = 0.85
# 超时先警告再通知：在 threshold × ratio 处注入「限一轮内交接」（默认 75%）
DEFAULT_TIMEOUT_WARN_RATIO = 0.75

# 收尾窗口允许的工具（落盘 + handoff；调查/执行类一律剔除）
WIND_DOWN_ALLOWED_TOOLS = frozenset(
    {
        "handoff",
        "file_write",
        "str_replace",
        "file_move",
        "file_copy",
        "mkdir",
        "file_batch",
        "file_list",
    }
)

WIND_DOWN_INSTRUCTION_TOKEN = (
    "[系统提示] 累计 token 已接近预算硬顶。本轮起进入收尾窗口：仅允许落盘"
    "（file_write / str_replace 等）与 handoff。"
    "请立即把已有产出落盘并调用 handoff 提交交接简报；禁止继续调查或开新战线。"
)

WIND_DOWN_INSTRUCTION_TIMEOUT = (
    "[系统提示] 墙钟已接近超时阈值。限一轮内完成交接：仅允许落盘与 handoff，"
    "请立即提交合格 handoff；超时后将仅通知 CEO（不会自动取消你），但继续空转"
    "可能导致降级合成简报。"
)


def reason_for_warning(text: str) -> str | None:
    """Map a canonical cutoff warning string to its reason code, or None."""
    return WARNING_TO_REASON.get(str(text).strip())


def warning_for_reason(reason: str) -> str | None:
    """Canonical warning text for a reason code, or None if unknown."""
    return REASON_TO_WARNING.get(reason)


def should_enter_token_wind_down(tokens: int, budget: int, ratio: float) -> bool:
    """True when cumulative tokens have reached the soft wind-down threshold."""
    if budget <= 0 or not (0.0 < ratio < 1.0):
        return False
    return tokens >= int(budget * ratio)


def narrow_tools_for_wind_down(
    available: set[str],
    *,
    allowed: list[str] | None,
) -> list[str]:
    """Intersect caller's allow-list with the wind-down persist/handoff whitelist."""
    base = set(allowed) if allowed is not None else set(available)
    narrowed = sorted(base & WIND_DOWN_ALLOWED_TOOLS)
    if "handoff" in available and "handoff" not in narrowed:
        narrowed.append("handoff")
    return narrowed
