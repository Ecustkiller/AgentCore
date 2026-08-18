"""Plan-time retrieval budget (检索与交付约束前置提案 A1 + R-02 搜/读分池).

Structured defaults on ``RunSpec.retrieval_budget`` (搜索池) + ``RunSpec.retrieval_read_budget``
(读池) + strip the matching tool when the resolved limit is 0. Runtime counter lives on
``ToolContext.retrieval_budget`` (:class:`~agentcore.tools.protocol.RetrievalBudgetState`);
enforce in ``tool_exec`` (orthogonal to LoopController / team_gate). Cache hits and A3
query-contract rejects do not consume budget. CEO / delegate schema 不可配置该字段；额度只
来自统一常量（辩手有约定文档窄例外由辩论内部 writer 补写）。

R-02：``web_search`` 与 ``read_url`` 拆两池——搜索按「调用一次」计一 slot，深读按「页」计
（页 = :data:`READ_PAGE_CHARS` 字符，``read_url`` 按正文量扣页）。读池预留按请求 ``max_chars``
的上界，执行后回退到实际正文页数。二者相互独立，不再共用一池。

预算感知：花过额度的 worker 每轮由 :func:`sync_retrieval_budget_awareness` 注入一条
当前余额（搜索+读池分列），临界告知并进同一条——只让模型别盲搜/盲读。
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil
from typing import TYPE_CHECKING, Any

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.tools.protocol import RetrievalBudgetState

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunSpec
    from agentcore.tools.protocol import ToolResult

__all__ = [
    "BUDGET_EXHAUSTED_FEEDBACK",
    "DEFAULT_RETRIEVAL_BUDGET",
    "DEFAULT_RETRIEVAL_BUDGET_DEBATER_WITH_DOSSIER",
    "READ_PAGE_CHARS",
    "RETRIEVAL_BUDGET_AWARENESS_PREFIX",
    "RETRIEVAL_BUDGET_CRITICAL_REMAINING",
    "RETRIEVAL_TOOL_NAMES",
    "RetrievalBudgetAwareness",
    "RetrievalBudgetState",
    "apply_retrieval_budgets",
    "apply_retrieval_budgets_to_specs",
    "budget_exhausted_output",
    "charges_retrieval_budget",
    "default_retrieval_budget",
    "default_retrieval_read_budget",
    "drop_retrieval_budget_awareness",
    "exclude_retrieval_tools",
    "format_retrieval_budget_awareness_prompt",
    "format_retrieval_budget_critical_prompt",
    "format_retrieval_budget_line",
    "is_retrieval_budget_critical",
    "parse_retrieval_budget",
    "read_pages_for_chars",
    "retrieval_charge_quantity",
    "retrieval_reserve_quantity",
    "rework_refill_slots",
    "sync_retrieval_budget_awareness",
]

# Tools that each own an independent per-run retrieval pool (R-02).
RETRIEVAL_TOOL_NAMES: frozenset[str] = frozenset({"web_search", "read_url"})
SEARCH_TOOL_NAME = "web_search"
READ_TOOL_NAME = "read_url"

# 全员统一默认：普通 worker 搜索池 → 14（含 form=prose）。开发期无真实产线数据，14 为假设
# 统一阀（原 RESEARCH 档复用；已删 prose→0 / ROOT/DOWNSTREAM / 透镜 base/gap /
# CEO 显式覆盖）。不做批级共享池 / 按 worker 数缩放——接受 N×线性税。
DEFAULT_RETRIEVAL_BUDGET = 14
# 辩手有幕1 约定文档时：约定文档已覆盖底料，只留残搜槽位补漏。原 4 → 2026-07-22 复测：
# 约定文档充分时残搜 3 次几乎全是噪声域名，正文引用几乎全来自约定文档 → 校准为 2。
# 窄硬例外（内部 writer 写入 RunSpec，非 CEO 可配置），不是结构猜档。无约定文档路径不动。
DEFAULT_RETRIEVAL_BUDGET_DEBATER_WITH_DOSSIER = 2

# R-02 读池计量粒度：一「页」= 2000 字符正文。一次默认 8000 字深读 ≈ 4 页。
READ_PAGE_CHARS = 2000

# 同轮超订缓解：剩余槽位 ≤ 此值时经 reflection 注入提前告知，避免当轮 fan-out 超订被挡回。
RETRIEVAL_BUDGET_CRITICAL_REMAINING = 2

# 预算感知（BATS 实测：知不知道余额比额度大小更决定效果）每轮只留一条，靠此前缀识别并替换旧的。
# 必须与 wind_down 的「检索预算已用尽」收尾指令区分开——那条不归本路径管，不能被顺手删掉。
RETRIEVAL_BUDGET_AWARENESS_PREFIX = "[系统提示] 检索余额"

BUDGET_EXHAUSTED_FEEDBACK = (
    "检索预算已尽：请基于证据台账中现有材料交付，并在交接（handoff）中如实标注检索缺口"
    "（缺什么、为何没补上）。不要再调用 web_search / read_url。"
)


def parse_retrieval_budget(raw: Any) -> int | None:
    """Normalise an internal ``retrieval_budget`` int; ``None`` = omit / invalid.

    Not a CEO/delegate config path — schema 已不暴露该字段；仅供辩论等内部 writer
    在 plan 建成后补写窄例外时规范化。
    """
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int) and raw >= 0:
        return raw
    if isinstance(raw, float) and raw >= 0 and raw == int(raw):
        return int(raw)
    return None


def default_retrieval_budget(spec: RunSpec, *, complexity_hint: str = "standard") -> int:
    """Structured default — unified single value for all ordinary workers (搜索池).

    R-04：优先 settings.engine_retrieval_budget（回落 :data:`DEFAULT_RETRIEVAL_BUDGET`
    =14）；settings 不可用（unit stubs）或 ≤0 语义由调用方处理（≤0 → 卸 web_search）。
    ``form`` / role 不参与分档。辩手有约定文档残搜 2 由辩论内部 writer 在 plan 建成后
    写入，不经本函数。``complexity_hint`` 保留签名兼容，**不再**参与分档。
    """
    del complexity_hint  # API compat only; no tiering
    del spec  # form / deps 不再影响默认
    try:
        from agentcore.config import settings

        value = int(settings.engine_retrieval_budget)
        return value
    except Exception:  # noqa: BLE001 — settings optional in unit stubs
        return DEFAULT_RETRIEVAL_BUDGET


def default_retrieval_read_budget(spec: RunSpec) -> int:
    """Structured default for the read pool (read_url 深读页数，R-02).

    优先 settings.engine_retrieval_read_budget；回落与搜索池同值（`default_retrieval_budget`
    的 int）。settings 不可用（unit stubs）时回落 :data:`DEFAULT_RETRIEVAL_BUDGET`。
    ≤0 语义由调用方处理（≤0 → 卸 read_url）。
    """
    try:
        from agentcore.config import settings

        return int(settings.engine_retrieval_read_budget)
    except Exception:  # noqa: BLE001 — settings optional in unit stubs
        return default_retrieval_budget(spec)


def read_pages_for_chars(chars: int) -> int:
    """How many read pages ``chars`` of body text consume (≥1 per live read)."""
    if chars <= 0:
        return 1
    return max(1, ceil(chars / READ_PAGE_CHARS))


def _read_max_chars_from_args(args: dict[str, Any]) -> int:
    """Requested ``max_chars`` from a ``read_url`` call (clamped to the tool's cap)."""
    raw = args.get("max_chars", 8000)
    try:
        raw = int(raw)
    except (TypeError, ValueError):
        raw = 8000
    return max(1, min(raw, 30000))


def retrieval_reserve_quantity(tool: str, args: dict[str, Any]) -> int:
    """Units to reserve up front for a live ``tool`` call.

    ``web_search`` = 1 slot; ``read_url`` = page-count upper bound from the requested
    ``max_chars`` (refunded down to the actual page count after execution).
    """
    if tool != READ_TOOL_NAME:
        return 1
    return read_pages_for_chars(_read_max_chars_from_args(args))


def retrieval_charge_quantity(tool: str, result: ToolResult) -> int:
    """Units a charged ``tool`` result actually consumes (after a live, non-cached call).

    ``web_search`` = 1; ``read_url`` = pages for ``metadata.content_chars`` (≥1).
    """
    if tool != READ_TOOL_NAME:
        return 1
    meta = result.metadata or {}
    try:
        content_chars = int(meta.get("content_chars") or 0)
    except (TypeError, ValueError):
        content_chars = 0
    return read_pages_for_chars(content_chars)


def exclude_retrieval_tools(
    tools: list[str] | None,
    valid_tools: set[str] | None,
    *,
    only: frozenset[str] = RETRIEVAL_TOOL_NAMES,
) -> list[str] | None:
    """Remove the ``only`` retrieval tools from an allow-list (预算 0 → 不装配).

    ``only`` narrows which tools to strip (e.g. just ``read_url`` when the read pool
    is 0 but search stays open). Unrestricted (``None``) becomes an explicit list of
    ``valid_tools`` minus ``only`` when ``valid_tools`` is known. Returns ``[]`` (not
    ``None``) when the stripped set is empty — unlike builder._tools, empty here means
    "no tools from the declared set" so the engine does not re-open all tools;
    escalate / notes are re-granted later by the executor.
    """
    if tools is not None:
        return [t for t in tools if t not in only]
    if valid_tools is not None:
        return sorted(valid_tools - only)
    return None


def apply_retrieval_budgets(
    plan: RunPlan,
    *,
    valid_tools: set[str] | None = None,
    complexity_hint: str = "standard",
) -> None:
    """Fill structured defaults on every node; strip retrieval tools when limit is 0."""
    for spec in plan.nodes:
        _apply_one(spec, valid_tools=valid_tools, complexity_hint=complexity_hint)


def apply_retrieval_budgets_to_specs(
    specs: list[RunSpec],
    *,
    valid_tools: set[str] | None = None,
    complexity_hint: str = "standard",
) -> None:
    """Same as :func:`apply_retrieval_budgets` for a replan ``add`` batch."""
    for spec in specs:
        _apply_one(spec, valid_tools=valid_tools, complexity_hint=complexity_hint)


def _apply_one(
    spec: RunSpec, *, valid_tools: set[str] | None, complexity_hint: str = "standard"
) -> None:
    # 额度只来自结构化默认；CEO/task 字段不再写入。内部 writer（辩手有约定文档）在
    # apply 之后补写 RunSpec.retrieval_budget / retrieval_read_budget，故此处仅填 None。
    if spec.retrieval_budget is None:
        spec.retrieval_budget = default_retrieval_budget(spec, complexity_hint=complexity_hint)
    if spec.retrieval_read_budget is None:
        spec.retrieval_read_budget = default_retrieval_read_budget(spec)
    # R-02 分池剥工具：搜索 0 卸 web_search，读 0 卸 read_url，二者独立。
    strip_only = _strip_target_tools(spec)
    if strip_only:
        stripped = exclude_retrieval_tools(spec.tools, valid_tools, only=strip_only)
        if stripped is not None:
            spec.tools = stripped


def _strip_target_tools(spec: RunSpec) -> frozenset[str]:
    """Retrieval tools to drop from the allow-list when their pool resolves to 0."""
    targets: set[str] = set()
    if spec.retrieval_budget == 0:
        targets.add(SEARCH_TOOL_NAME)
    if spec.retrieval_read_budget == 0:
        targets.add(READ_TOOL_NAME)
    return frozenset(targets)


def format_retrieval_budget_line(
    budget: int | None, read_budget: int | None = None
) -> str:
    """Worker-facing one-liner for the deliverable / context block (R-02 分池)."""
    if budget is None and read_budget is None:
        return ""
    search_off = budget is not None and budget <= 0
    read_off = read_budget is not None and read_budget <= 0
    if search_off and read_off:
        return (
            "- 检索预算：0（本任务不装配 web_search / read_url；"
            "基于上游与台账现有证据交付，缺口在交接中标注）"
        )
    parts: list[str] = []
    if budget is not None:
        if budget <= 0:
            parts.append("web_search 0 次（不装配）")
        else:
            parts.append(f"web_search 最多 {budget} 次")
    if read_budget is not None:
        if read_budget <= 0:
            parts.append("read_url 0 页（不装配）")
        else:
            parts.append(f"read_url 最多 {read_budget} 页")
    return (
        f"- 检索预算：{'；'.join(parts)}"
        "（缓存命中不计）；用尽后基于台账现有证据交付并在交接中标注检索缺口。"
    )


def is_retrieval_budget_critical(remaining: int, *, limit: int) -> bool:
    """True when budget is still open but remaining slots are critically low.

    Used by the engine to inject a one-shot reflection before the next think round,
    so the model does not fan out more ``web_search``/``read_url`` calls than slots left.
    Exhausted (``remaining <= 0``) is handled by wind_down, not this path.
    """
    if limit <= 0:
        return False
    return 0 < remaining <= RETRIEVAL_BUDGET_CRITICAL_REMAINING


def format_retrieval_budget_critical_prompt(state: RetrievalBudgetState) -> str:
    """``[系统提示]`` steer when retrieval slots are critically low (同轮超订缓解).

    Also the 临界轮的余额播报：搜索+读池余额并进同一条，不另发一段预算文字。
    """
    return (
        f"{RETRIEVAL_BUDGET_AWARENESS_PREFIX}：检索余额告急——"
        f"web_search 剩余 {state.remaining}/{state.limit} 次，"
        f"read_url 剩余 {state.read_remaining}/{state.read_limit} 页"
        "（缓存命中不计）。下一轮请只发起不超过剩余额度的检索调用，"
        "优先深读最关键来源；勿并行扇出超过剩余槽位的查询——超订会被挡回并浪费本轮。"
        "若现有证据已够，请直接基于台账交付并在交接中标注检索缺口。"
    )


def format_retrieval_budget_awareness_prompt(state: RetrievalBudgetState) -> str:
    """Per-round balance readout for a worker that already spent slots (R-02 分池)."""
    return (
        f"{RETRIEVAL_BUDGET_AWARENESS_PREFIX}："
        f"web_search 已用 {state.searches_used}/{state.limit} 次 · 剩余 {state.remaining} 次；"
        f"read_url 已读 {state.reads_used}/{state.read_limit} 页 · 剩余 {state.read_remaining} 页"
        "（缓存命中不计）。请按剩余额度规划：先明确这一轮要验证什么再检索，"
        "避免重复查询与低价值扇出；额度用尽后只能基于台账现有证据交付，"
        "并在交接中标注检索缺口。"
    )


@dataclass(frozen=True)
class RetrievalBudgetAwareness:
    """What :func:`sync_retrieval_budget_awareness` injected this round (供埋点读)."""

    text: str
    critical: bool
    limit: int
    read_limit: int
    used: int
    read_used: int
    remaining: int
    read_remaining: int
    searches: int
    reads: int


def _budget_critical(state: RetrievalBudgetState) -> bool:
    """Critical when any still-open pool is critically low (search or read)."""
    return (
        is_retrieval_budget_critical(state.remaining, limit=state.limit)
        or is_retrieval_budget_critical(state.read_remaining, limit=state.read_limit)
    )


def _is_awareness_message(msg: LLMMessage) -> bool:
    return (
        msg.role == "user"
        and isinstance(msg.content, str)
        and msg.content.startswith(RETRIEVAL_BUDGET_AWARENESS_PREFIX)
    )


def drop_retrieval_budget_awareness(messages: list[LLMMessage]) -> bool:
    """Remove the balance message; True ⇒ transcript changed.

    Called on its own once the run stops searching (wind_down / exhausted), where a
    lingering "还剩 N 次" would contradict the 收尾 instruction.
    """
    if not any(_is_awareness_message(m) for m in messages):
        return False
    messages[:] = [m for m in messages if not _is_awareness_message(m)]
    return True


def sync_retrieval_budget_awareness(
    messages: list[LLMMessage], state: RetrievalBudgetState
) -> RetrievalBudgetAwareness | None:
    """Refresh the single balance message at the tail; ``None`` ⇒ nothing injected.

    预算感知（BATS）：花过额度的 worker 每轮都要看到「已用多少 / 还剩多少」，否则只能盲搜。
    Skipped for a worker that never spent a slot（生产上多数 worker 一次都不检索，注入是纯
    噪音）、两池全关（``limit <= 0`` 且 ``read_limit <= 0``）、以及两池全耗尽（收尾话术归
    wind_down，行为不变）。临界（任一开放池剩余 ≤ :data:`RETRIEVAL_BUDGET_CRITICAL_REMAINING`）
    与提前告知合并成同一条。
    Refreshing = drop the stale copy then append, so the transcript never carries two
    contradicting balances and the current one stays adjacent to the next think round.
    """
    drop_retrieval_budget_awareness(messages)
    if state.limit <= 0 and state.read_limit <= 0:
        return None
    if state.used <= 0 and state.read_used <= 0:
        return None
    if state.any_exhausted:
        return None
    critical = _budget_critical(state)
    text = (
        format_retrieval_budget_critical_prompt(state)
        if critical
        else format_retrieval_budget_awareness_prompt(state)
    )
    messages.append(LLMMessage(role="user", content=text))
    return RetrievalBudgetAwareness(
        text=text,
        critical=critical,
        limit=state.limit,
        read_limit=state.read_limit,
        used=state.used,
        read_used=state.read_used,
        remaining=state.remaining,
        read_remaining=state.read_remaining,
        searches=state.searches_used,
        reads=state.reads_used,
    )


def rework_refill_slots(
    *,
    original_limit: int,
    wind_down_entered: bool,
    write_disk_form: bool = False,
) -> int:
    """How many retrieval slots a contract rework may add (预算语义不绕过).

    - Write-disk form (``form=files`` / artifacts landing) rework: **0** — worker
      needs a directed write/repair pass, not more ``web_search``/``read_url``.
    - After token / timeout wind_down: **0** — rework must not restore investigation.
    - Otherwise: half the original resolved budget (min 1), same slice size as before.
    Caller must apply via :meth:`RetrievalBudgetState.refill_within_cap` with
    ``cap=original_limit`` so the absolute ceiling never grows past the plan-time
    budget (unlike unbounded :meth:`~RetrievalBudgetState.refill`).
    """
    if write_disk_form or wind_down_entered or original_limit <= 0:
        return 0
    return max(1, int(original_limit) // 2)


def charges_retrieval_budget(result: ToolResult) -> bool:
    """True when a completed retrieval call should consume one budget slot.

    Cache hits (``metadata.cached``) do not charge. Failures (including A3 query
    contract rejects) do not charge — they never produced a live backend hit worth
    counting, and A3 must remain free to rewrite (提案 A3).
    """
    if not result.success:
        return False
    meta = result.metadata or {}
    return not meta.get("cached")


def budget_exhausted_output() -> str:
    return BUDGET_EXHAUSTED_FEEDBACK
