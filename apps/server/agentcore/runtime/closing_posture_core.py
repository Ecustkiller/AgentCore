"""Tier truth source + posture A/C/draft closed sets + honesty rework orchestration.

真源是 ``delivery_verdict.state``（非完成话术词表）：

- ``delivered`` = 正式完成（允许姿势 A）
- ``partial`` / ``notes`` ≈ 草稿·部分（禁止姿势 A；``requires_draft_ack`` 时另须正文承认缺口）
- ``blocked`` = 阻塞（禁止姿势 A；``requires_draft_ack`` 时另须承认缺口）

姿势 A = 宣称完整交付 / 全员收卷 / 完整可用 / 修好验绿。
探测用**闭集**正则，仅作「是否在说 A」的薄信号；**禁止**靠案面加完成话术词修案。
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.runtime.delegate.delivery_status import DeliveryVerdict

# 正式完成档（唯一允许姿势 A 的对账态）。
_FORMAL_COMPLETE_TIERS = frozenset({"delivered"})
# 非正式完成：草稿·部分·阻塞 —— 不得姿势 A。
_INFORMAL_TIERS = frozenset({"partial", "notes", "blocked"})

# (A) 完整交付宣称闭集。故意不含裸「已完成 / 已交付 / 弱可用」——修码/建站正常收口不得误伤。
# ✅ 已撤回 20260803「复核/审查/验收通过、已修复、可玩」扩面；乙（修好/验绿）仍在。
# 禁止再往本表加案面词（「综述已完成」「站点做好了」等）；漏拦应回到档位/产物结构，而非加词。
_POSTURE_A_CLAIMS = re.compile(
    r"(?:"
    r"已全部收卷|全部收卷|已收卷|"
    r"已全部收齐|全部收齐|已收齐|"
    r"已完成交付|交付已完成|完成交付|交付完成|已经交付完成|"
    r"已全部(?:完成|交付|就位|成功|就绪)|"
    r"全部(?:完成|交付|就位|成功|就绪)|"
    r"均已(?:完成|交付|就绪|成功|落盘)|"
    r"都已(?:完成|交付|就绪|成功)|"
    r"所有(?:任务|队员|节点)(?:已|都已)(?:完成|交付|就绪)|"
    r"已完整可用|已可以使用|已经可以使用|"
    r"已完全可用|已可直接使用|已经可以直接使用|"
    r"已修好|修复已完成|bug\s*已修复|缺陷已修复|问题已修复|"
    r"已验证通过|验证通过|验证已绿|验证已通过|"
    r"测试已通过|已跑通测试|测试已跑通"
    r")"
)

# (C) 需用户确认 / 关键缺口阻塞——仅无档位时的 A∪C 与 resume 确认姿势用；保持极窄。
_POSTURE_C_CLAIMS = re.compile(
    r"(?:"
    r"请确认|"
    r"需要先确认|"
    r"先确认(?:一个)?关键|"
    r"关键(?:信息|缺口|事实)(?:未定|未明确|未齐)|"
    r"关键缺口|"
    r"方向：先问你|"
    r"先问你\s*/\s*关键|"
    r"未明确——"
    r")"
)

# partial/blocked 时正文须出现的「草稿/缺口承认」闭集（正向要求，不是完成话术黑名单）。
# 漏拦「综述已完成」等变体 → 扩本表或靠档位+承认，禁止往姿势 A 加案面词。
_DRAFT_ACK_CLAIMS = re.compile(
    r"(?:"
    r"草稿|"
    r"证据不足|证据不够|证据差|"
    r"部分完成|部分未完成|尚未完成|仍未完成|"
    r"未完成项|关键缺口|仍有缺口|存在缺口|"
    r"待补|待核实|待完善|需改进|"
    r"仅供参考|非正式(?:版|稿)|"
    r"未能(?:检索|完成|交付)|搜不到|"
    r"靠先验|基于先验|基于对该领域的了解"
    r")"
)

_GAP_NEGATION_PREFIXES = ("尚未", "没有", "并未", "未", "没", "无", "勿", "禁止", "不要")

_TIER_LABEL = {
    "blocked": "未满足/阻塞",
    "partial": "部分未满足",
    "notes": "草稿/备注",
}

# 硬降档（evidence_deficit / thin_review / verify_failed / node_failed /
# artifact_rejected → requires_draft_ack）时须承认缺口；普通 partial 不强制。
# （notes 仅软提醒时仍只拦姿势 A；FAILED soft 投影保留 node_failed 则亦闩。）


def is_formal_complete_tier(state: str | None) -> bool:
    """True when delivery_verdict.state allows posture A (正式完成)."""
    return (state or "") in _FORMAL_COMPLETE_TIERS


def tier_forbids_posture_a(state: str | None) -> bool:
    """True when tier is partial/notes/blocked — posture A is dishonest."""
    return (state or "") in _INFORMAL_TIERS


def _positive_hits(pattern: re.Pattern[str], content: str) -> bool:
    """True when pattern matches a non-negated claim."""
    for match in pattern.finditer(content or ""):
        start = match.start()
        # Always honor negation prefixes（尚未全部完成 / 尚未完成交付…）——
        # even when the matched token itself starts with「全部/已」.
        prefix = content[max(0, start - 2) : start]
        if any(prefix.endswith(neg) for neg in _GAP_NEGATION_PREFIXES):
            continue
        return True
    return False


def claims_posture_a(content: str) -> bool:
    """True when prose asserts formal-complete delivery (posture A). Closed set — do not expand."""
    return _positive_hits(_POSTURE_A_CLAIMS, content or "")


def claims_posture_c(content: str) -> bool:
    """True when prose asks the user to confirm a blocking gap (posture C)."""
    return _positive_hits(_POSTURE_C_CLAIMS, content or "")


def claims_draft_acknowledgment(content: str) -> bool:
    """True when prose acknowledges draft / gap / evidence shortfall (partial/blocked)."""
    return bool(_DRAFT_ACK_CLAIMS.search(content or ""))


# Resume / rehydrate 兼容别名（语义 = 姿势 A / C）。
claims_full_delivery = claims_posture_a
claims_needs_confirm = claims_posture_c


def closing_honesty_rework(
    content: str,
    delivery_verdict: DeliveryVerdict | None = None,
) -> str | None:
    """档位驱动的收口诚实性回炉项；无档位时退回薄 A∪C。

    主路径：``delivery_verdict.state`` ∉ 正式完成 → 不得姿势 A；
    ``requires_draft_ack``（evidence_deficit / thin_review / verify_failed /
    node_failed / artifact_rejected）另须正文出现草稿/缺口承认（正向要求，不靠加完成词）。
    B1：浏览器声称须 tool 成功；零写禁称落盘；超席/空交接/cancel·0 须 PARTIAL 缺口清单。
    无对账卡：同条不得既 C 又 A（少靠双边大词表；C/A 均为闭集）。
    """
    # Late imports: B1 probe axes live in sibling latch modules (avoid import cycles).
    from agentcore.runtime.closing_posture_b1 import (
        _browser_claim_rework,
        _ceiling_hollow_teach_rework,
        _partial_storm_rework,
        _verify_budget_hollow_rework,
        _zero_write_landing_rework,
    )
    from agentcore.runtime.closing_posture_ceo_mutation import (
        claims_ceo_mutation_done,
        claims_disk_landing,
        turn_has_product_write_evidence,
    )

    text = content or ""
    if not text.strip():
        return None

    # B1 structural axes first（真源=装配/tool/对账 latch，不扫用户气泡）。
    # 零写须吃显式 delivery_verdict.delivered_files（finish_guard 传入），不能只读 ContextVar。
    browser_hit = _browser_claim_rework(text)
    if browser_hit:
        return browser_hit
    zero_write = _zero_write_landing_rework(text, delivery_verdict=delivery_verdict)
    if zero_write:
        return zero_write
    for probe in (
        _partial_storm_rework,
        _verify_budget_hollow_rework,
        _ceiling_hollow_teach_rework,
    ):
        hit = probe(text)
        if hit:
            return hit

    if delivery_verdict is not None:
        state = delivery_verdict.state
        # 有对账卡但零 files：再拦落盘声称（与 _zero_write 互补；verdict 有 files 时已放行）。
        if (
            not delivery_verdict.delivered_files
            and (claims_ceo_mutation_done(text) or claims_disk_landing(text))
            and not turn_has_product_write_evidence(delivery_verdict=delivery_verdict)
        ):
            return (
                f"本回合交付对账档位为「{_TIER_LABEL.get(state, state)}」且无落盘文件——"
                "正文不得声称已落盘 / 已修改完成。请改 PARTIAL：缺口清单 + 下一步。"
            )
        if not tier_forbids_posture_a(state):
            return None
        label = _TIER_LABEL.get(state, state)
        if claims_posture_a(text):
            return (
                f"本回合交付对账档位为「{label}」（state={state}，见交付状态卡）——"
                "非正式完成档，正文不得姿势 A（宣称完整交付 / 全员收卷收齐 / "
                "已完整可用 / 已修好或验绿等）。"
                "请按档位改写：blocked → 承认阻塞与缺口；"
                "partial/notes → 标部分完成并点名未完成项；"
                "不要用完成话术盖过对账档位。"
                "真源=delivery_verdict 档位；禁止案面加完成话术词修案。"
            )
        if getattr(delivery_verdict, "requires_draft_ack", False) and (
            not claims_draft_acknowledgment(text)
        ):
            return (
                f"本回合交付对账档位为「{label}」（state={state}，须草稿/缺口承认）——"
                "正文须在开场承认草稿/部分完成/证据不足或点名未完成项，"
                "不得仅用字数或「已完成」叙事冒充正式交付。"
                "请把缺口写在最前面；真源=对账档位，禁止靠加完成话术词修案。"
            )
        return None

    # 无对账卡：仅拦同条 A∪C 自相矛盾。
    if not (claims_posture_a(text) and claims_posture_c(text)):
        return None
    return (
        "本条收口正文同时出现「需用户确认 / 关键缺口」（姿势 C）与"
        "「完整交付 / 收卷收齐 / 验绿」类宣称（姿势 A）——"
        "完成态互斥：同一条用户可见收口只能是其一："
        "(A) 已交付完整结果；(B) 部分完成并标明未完成项；(C) 阻塞/需确认（不声称已交付）。"
        "请改写为单一姿势：若仍缺关键信息 → 只保留确认请求（可再调 ask_user），"
        "删除收卷/已收齐/完整交付宣称；"
        "若已可交付 → 删除请确认/关键缺口话术，只写交付概览与缺口（有则标部分完成）。"
    )


def mutual_exclusion_rework(content: str) -> str | None:
    """无档位时的 A∪C 互斥（兼容旧调用）；有档位请用 :func:`closing_honesty_rework`。"""
    return closing_honesty_rework(content, delivery_verdict=None)
