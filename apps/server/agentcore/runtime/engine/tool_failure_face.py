"""User-facing tool failure face (``tool_use_end.failure``) — category gate.

Isomorphic to :func:`agentcore.core.errors.error_fields_for`:

- Authored product copy (engine deny paths / optional ``ToolResult.failure_message``)
  passes through with a stable ``code``.
- :class:`~agentcore.core.errors.AgentCoreError` on the exception path passes through
  its type-owned code + message.
- Everything else (raw ``str(exc)``, model-facing join text, internal tokens) collapses
  to a curated Chinese sentence for the given code — never the technical detail.

Model-facing ``tool_use_end.result`` / transcript stay untouched; this module only
builds the optional ``failure: {message, code}`` user channel.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import AgentCoreError

# Default user sentence when no authored product copy / coded AgentCoreError is present.
DEFAULT_TOOL_FAILURE_MESSAGE = "工具执行失败，请稍后重试。"

# Stable-code → curated Chinese (never ``str(exc)``). Engine-authored paths that already
# carry product Chinese pass that text via ``product_message`` instead of this table.
# Twin of tool-side ``metadata["code"]`` / ``ToolResult.failure_code`` — review copy here.
# String literals below stay byte-equal to their tool/db sources (no import — avoids
# engine ↔ db/tools cycles): ``db.errors.DATABASE_UNAVAILABLE_MESSAGE``,
# ``exec_env.EXEC_ENV_PROBE_FAIL_USER_MESSAGE``, ``core.net`` local-search connect copy.
#
# Copy rule for every sentence here: say what happened, what it means for the user, and
# what they can do — in that order, in the user's own vocabulary. Deny paths steer the
# model with imperatives ("不要原样重试" / "请改用其他方案"); those belong on ``result``
# only. A denial the user themselves issued must never come back as an order to them,
# and an unattended path must never promise a confirmation UI that does not exist.
# Engine concepts (run / 收口 / 台账 / handoff / 落盘 / 活性挂起 / 白名单 / 检索预算 /
# 收尾窗口 / 结构闸) are internal — they never appear below.
_CURATED_BY_CODE: dict[str, str] = {
    ErrorCode.TOOL_ERROR: DEFAULT_TOOL_FAILURE_MESSAGE,
    ErrorCode.TOOL_NOT_FOUND: "当前无法使用该工具，请换一种方式继续。",
    ErrorCode.SANDBOX_ERROR: "代码执行环境暂时不可用，请稍后重试。",
    ErrorCode.SANDBOX_TIMEOUT: "代码执行超时，请缩小范围后重试。",
    ErrorCode.VALIDATION_ERROR: "工具参数无效，已中止本次调用。",
    ErrorCode.FORBIDDEN: "当前无权执行该操作。",
    ErrorCode.NOT_FOUND: "未找到所需资源，请换一种方式继续。",
    ErrorCode.RATE_LIMITED: "请求过于频繁，请稍后再试。",
    ErrorCode.QUOTA_EXCEEDED: "用量已达上限，请稍后再试或调整配额。",
    ErrorCode.STREAM_ERROR: "工作区通道暂时不可用，请稍后重试。",
    ErrorCode.DATABASE_UNAVAILABLE: "AgentCore 服务暂时不可用，请稍后重试",
    "database_unavailable": "AgentCore 服务暂时不可用，请稍后重试",
    # Engine meta codes (not ErrorCode members) — still stable on the wire.
    "retrieval_budget_exhausted": (
        "本次任务的联网查资料次数已用完，这一次没有再去搜；我会基于已经查到的内容继续。"
    ),
    "args_parse_failed": "工具参数无效，已中止本次调用。",
    "allowlist_deny": (
        "这一步要用的工具不在本次任务的可用范围内，已跳过。如果需要，可以让我换个方式来做。"
    ),
    # The task is out of time / tokens and only finishing tools stay open.
    "wind_down_deny": "本次任务已接近时间或用量上限，正在整理结果，这一步用到的工具已经停用。",
    # Safety fuse. Nothing ran, so the user's files and data are untouched — say so.
    "safety_breaker_deny": (
        "出于安全考虑，这一步操作已被拦下，没有执行。如果确实需要，请告诉我你想怎么做。"
    ),
    # Fuse / confirmation needed but nobody to ask (unattended job, ops kill switch).
    # A conversation really does have the confirmation card, so pointing there is honest;
    # naming a generic「可确认的界面」to someone who is already the user is not.
    "safety_breaker_unattended": (
        "这一步有安全风险，而当前任务在后台运行、无法向你确认，已跳过。"
        "如果确实需要，可以在对话里让我重做这一步。"
    ),
    "approval_unattended": (
        "这一步需要你确认才能执行，而当前任务在后台运行、无法向你确认，已跳过。"
        "如果需要执行，可以在对话里让我重做这一步。"
    ),
    # Covers an explicit refuse *and* a card that timed out — hence「没有得到确认」rather
    # than「你拒绝了」.
    "approval_denied": (
        "这一步没有得到你的确认，没有执行，也没有改动任何东西。想继续的话告诉我一声。"
    ),
    "timeout": "这一步等了很久都没有响应，已经中止。可以让我缩小范围或换个方式再试一次。",
    "liveness_timeout": "这一步等了很久都没有响应，已经中止。可以让我缩小范围或换个方式再试一次。",
    "workspace_channel_dead": "工作区通道暂时不可用，请稍后重试。",
    "landed_status_name": "参数无效：请调用真实的写盘工具。",
    "host_unavailable": "浏览器宿主暂时不可用，请稍后重试。",
    "searxng_unreachable": "本地搜索服务不可用，请稍后重试",
    "exec_timeout": "执行超时，请缩小范围后重试。",
    "exec_forced_stop": "执行已强制中止，请缩小范围后重试。",
    "exec_env_probe_failed": (
        "本机执行环境自检未通过（连最短 print 都无法完成）。"
        "请检查本机 Python / 安全软件后重试。"
    ),
}


def tool_failure_fields(
    *,
    code: str | None = None,
    product_message: str | None = None,
    exc: BaseException | None = None,
) -> dict[str, str]:
    """Return ``{"message", "code"}`` for ``tool_use_end.failure``.

    Category gate (not string matching on model-facing text):
    - ``exc`` is :class:`AgentCoreError` → pass through type code + product message.
    - Non-empty ``product_message`` → authored user copy (engine / rare ToolResult field).
    - Else → curated Chinese for ``code`` (default ``TOOL_ERROR``); never ``str(exc)``.
    """
    if isinstance(exc, AgentCoreError):
        msg = (exc.message or "").strip() or (
            (product_message or "").strip()
            or _CURATED_BY_CODE.get(exc.code, DEFAULT_TOOL_FAILURE_MESSAGE)
        )
        return {"message": msg, "code": exc.code}

    resolved_code = (code or "").strip() or ErrorCode.TOOL_ERROR
    authored = (product_message or "").strip()
    if authored:
        return {"message": authored, "code": resolved_code}

    curated = _CURATED_BY_CODE.get(resolved_code, DEFAULT_TOOL_FAILURE_MESSAGE)
    return {"message": curated, "code": resolved_code}


def tool_failure_from_result(result: Any) -> dict[str, str]:
    """Map a failed :class:`~agentcore.tools.protocol.ToolResult` to ``failure``.

    Uses optional ``failure_message`` / ``failure_code`` when a tool authored them;
    otherwise curated copy for ``metadata["code"]`` or ``TOOL_ERROR``. Never lifts
    ``error`` / ``output`` onto the user channel.
    """
    meta = getattr(result, "metadata", None) or {}
    meta_code = meta.get("code") if isinstance(meta, dict) else None
    if not isinstance(meta_code, str) or not meta_code.strip():
        meta_code = None
    return tool_failure_fields(
        code=getattr(result, "failure_code", None) or meta_code,
        product_message=getattr(result, "failure_message", None),
    )
