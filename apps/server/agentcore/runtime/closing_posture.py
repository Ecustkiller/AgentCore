"""用户可见收口诚实性：对账档位真源 + 极窄姿势探测。

真源是 ``delivery_verdict.state``（非完成话术词表）：

- ``delivered`` = 正式完成（允许姿势 A）
- ``partial`` / ``notes`` ≈ 草稿·部分（禁止姿势 A；``requires_draft_ack`` 时另须正文承认缺口）
- ``blocked`` = 阻塞（禁止姿势 A；``requires_draft_ack`` 时另须承认缺口）

姿势 A = 宣称完整交付 / 全员收卷 / 完整可用 / 修好验绿。
探测用**闭集**正则，仅作「是否在说 A」的薄信号；**禁止**靠案面加完成话术词修案。
文献证据降档时用正向「草稿/缺口承认」闭集（``requires_draft_ack``），不靠把「综述已完成」加进黑名单。
``requires_draft_ack`` 亦闩 ``thin_review``（已声明复核落盘未对齐）、``verify_failed``
（丙轴验证失败）、以及 ``node_failed`` / ``artifact_rejected``（契约硬失败·节点 FAILED·
拒收产物）——仍不扩姿势 A 词表。
无对账卡时，仅拦同条正文 A∪C 自相矛盾（resume 拼接同理）。

resume / plan_review：派工过程 kickoff（方向：派团队…）不进用户可见续写基底与 G6 重灌，
终稿另写交付说明，避免过程流水账（ce1ecfc2）。

``finish_guard`` / resume ``join`` / 确认姿势 steer 均消费本模块。
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

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
    无对账卡：同条不得既 C 又 A（少靠双边大词表；C/A 均为闭集）。
    """
    text = content or ""
    if not text.strip():
        return None

    if delivery_verdict is not None:
        state = delivery_verdict.state
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


# 派工/过程开工段（plan_review 前常见）：不得当「已交付前文」拼接或 G6 重灌进终稿气泡。
# 近零误报：显式派工话术；「阶段成果如下」等半交付续写故意不进。
_PROCESS_DISPATCH_PREAMBLE = re.compile(
    r"(?:"
    r"方向：派团队|"
    r"派团队\s*[—\-\u2013\u2014]|"
    r"直接开委派|"
    r"组建团队|"
    r"我(?:先)?派(?:出)?(?:\d+路|三路|各路|团队|队员)|"
    r"并行(?:开)?(?:派|调研)"
    r")"
)


def is_process_dispatch_preamble(content: str) -> bool:
    """True when prose is a dispatch/kickoff process note, not a deliverable half."""
    text = (content or "").strip()
    if not text:
        return False
    return bool(_PROCESS_DISPATCH_PREAMBLE.search(text))


def pre_pause_for_user_visible_continuity(pre_pause: str) -> str:
    """Strip process kickoff so it cannot seed bubble reinject / join as deliverable base.

    Ask-confirm framing is handled separately（卡片承载）；派工 kickoff 同理：过程已发生，
    终稿应另写交付说明，而非接着「方向：派团队」续写。
    """
    text = pre_pause or ""
    if is_process_dispatch_preamble(text):
        return ""
    return text


# 案 20260803-ask-empty-continue-default-dispatch · C：已派工后剥掉与事实互斥的「先问你」残留。
_STALE_ASK_ROUTE_LINE = re.compile(r"(?m)^[ \t]*方向：先问你[^\n]*\n+")
_STALE_PLEASE_CHOOSE_LINE = re.compile(r"(?m)^[ \t]*请选择[：:][^\n]*\n+")


def rewrite_stale_ask_after_dispatch(content: str) -> str:
    """Soft：已派工/按确认默认时剥掉「先问你」叠写，改为「已按默认开工」（不丢交付正文）。"""
    text = content or ""
    if not text.strip():
        return text
    has_ask_residual = ("方向：先问你" in text) or bool(
        re.search(r"(?m)^[ \t]*请选择[：:]", text)
    )
    if not has_ask_residual:
        return text
    dispatched = (
        is_process_dispatch_preamble(text)
        or "按确认默认" in text
        or "已按默认开工" in text
        or bool(re.search(r"派(?:一名|出)?(?:队员|团队)", text))
    )
    if not dispatched:
        return text
    dispatch_at = text.find("方向：派团队")
    ask_at = text.find("方向：先问你")
    if dispatch_at >= 0 and ask_at >= 0 and ask_at < dispatch_at:
        rest = text[dispatch_at:]
        if "已按默认开工" not in rest and "按确认默认" not in rest:
            return "已按默认开工。\n\n" + rest
        return rest
    rewritten = _STALE_ASK_ROUTE_LINE.sub("", text)
    rewritten = _STALE_PLEASE_CHOOSE_LINE.sub("", rewritten)
    if rewritten == text:
        return text
    if "已按默认开工" not in rewritten and "按确认默认" not in rewritten:
        return "已按默认开工。\n\n" + rewritten.lstrip()
    return rewritten


def reconcile_resume_closing(pre_pause: str, new: str) -> str:
    """Join resume segments without creating A∪C or process-kickoff∪交付流水账.

    When pre-pause still carries「请确认」 framing (often leftover ask prose) and the
    post-resume segment claims posture A, keep only the post-resume segment —
    the question already lived on the ask_user card; splicing recreates cef27dfa /
    e8fb470c dishonest closings.

    When pre-pause is ask framing（方向：先问你…）and post-resume already dispatched
    （方向：派团队… / 按确认默认）, keep only the post-resume segment — empty continue
    accepted the default; stacking「先问你」+「派团队」is dishonest（0cb83288）.

    When pre-pause is a dispatch/process kickoff（方向：派团队…）and post-resume has
    content, keep only the post-resume segment — kickoff must not become the opening
    of the user-visible交付说明（ce1ecfc2 过程流水账）.
    """
    left = pre_pause or ""
    right = new or ""
    if not left.strip():
        return rewrite_stale_ask_after_dispatch(right)
    if not right.strip():
        return left
    if claims_posture_c(left) and claims_posture_a(right):
        return rewrite_stale_ask_after_dispatch(right)
    if claims_posture_a(left) and claims_posture_c(right):
        # Rare: prior claimed done, resume asks again — prefer the later ask.
        return right
    if claims_posture_c(left) and (
        is_process_dispatch_preamble(right)
        or "按确认默认" in right
        or "已按默认开工" in right
    ):
        return rewrite_stale_ask_after_dispatch(right)
    if is_process_dispatch_preamble(left):
        return rewrite_stale_ask_after_dispatch(right)
    from agentcore.runtime.engine.segments import join_segments

    return rewrite_stale_ask_after_dispatch(join_segments(left, right))


def resume_continuity_steer(*, prior_deliverable: str) -> str:
    """Steer the resumed CEO round; avoid amplifying stale confirm / kickoff framing."""
    prior = (prior_deliverable or "").strip()
    if prior and claims_posture_c(prior) and not claims_posture_a(prior):
        return (
            "[系统提示] 用户已通过确认卡作答。请基于用户答复推进下一步。"
            "若卡上有预填 default 且用户空 continue = 确认该 default："
            "派工/正文须用该 default 并标「按确认默认」。"
            "【禁止】重复「请确认 / 关键缺口 / 先问你」话术；"
            "【禁止】借继续另拟一套还叠「先问你 / 请选择 / 方向：先问你」；"
            "【禁止】在同一条收口里既要确认又宣称完整交付 / 收卷收齐。"
            "若关键信息仍缺 → 再次 ask_user（正文只保留确认，不写收卷/已收齐）；"
            "若已可收口 → 只写交付概览；有未完成项则标部分完成，勿假完成。"
            "有交付对账卡时以档位为准（delivered=正式完成；否则不得姿势 A）。"
        )
    if prior and is_process_dispatch_preamble(prior):
        return (
            "[系统提示] 用户已确认计划/委派，派工过程段不要续进终稿。"
            "请另写一份给用户的交付说明（不要以「方向：派团队 / 开委派」开头，"
            "不要复述谁做了什么的工作日志）："
            "①结论或交付状态；②产物路径/看哪里；③缺口与建议下一步。"
            "有交付对账卡时以档位为准；非正式完成不得姿势 A。"
        )
    from agentcore.runtime.engine.segments import deliverable_continuity_instruction

    return deliverable_continuity_instruction(prior_deliverable=prior_deliverable)


# Hard-ceiling reasons that share the max_rounds honesty steer / banner path.
_CEILING_HONESTY_REASONS = frozenset({"max_rounds", "token_budget"})

_CEILING_HONESTY_STEER_LEAD = {
    "max_rounds": "本回合已达轮次硬上限（max_rounds），强制收口。",
    "token_budget": "本回合已达 token 预算硬上限（token_budget），强制收口。",
}

_CEILING_HONESTY_BANNERS = {
    "max_rounds": (
        "【收口说明】本回合因轮次上限强制结束，以下不得视为无条件验收通过——"
        "请按「部分落地 + 未闭合项」理解。\n\n"
    ),
    "token_budget": (
        "【收口说明】本回合因 token 预算上限强制结束，以下不得视为无条件验收通过——"
        "请按「部分落地 + 未闭合项」理解。\n\n"
    ),
}


def ceiling_honesty_steer(*, reason: str) -> str | None:
    """Steer force_finalize when hard ceiling forbids unconditional pass claims.

    Covers ``max_rounds`` and ``token_budget`` symmetrically (worker salvage + CEO).
    """
    r = (reason or "").strip()
    lead = _CEILING_HONESTY_STEER_LEAD.get(r)
    if lead is None:
        return None
    return (
        f"[系统提示] {lead}"
        "【禁止】无条件宣称验证通过 / 已修好 / 已全部完成 / 已完整可用等姿势 A；"
        "须按「部分落地 + 未闭合项」收口：点名已落地与未闭合，勿假装验收过关。"
        "有交付对账卡时以档位为准；非正式完成不得姿势 A。"
    )


def enforce_ceiling_closing_honesty(content: str, *, reason: str) -> str:
    """Deterministic backstop: ceiling salvage still claiming posture A → banner.

    force_finalize bypasses finish_guard; when the model ignores
    :func:`ceiling_honesty_steer`, prefix a short honesty note instead of
    shipping an unconditional pass claim. ``max_rounds`` / ``token_budget`` share
    this path; does **not** expand the posture-A closed set.
    """
    text = content or ""
    r = (reason or "").strip()
    banner = _CEILING_HONESTY_BANNERS.get(r)
    if banner is None or not claims_posture_a(text):
        return text
    stripped = text.lstrip()
    if stripped.startswith("【收口说明】"):
        return text
    return banner + text

# --- CEO mutation honesty (案 20260803-ceo-claim-edit-without-write · 软Ⅱ′) ---
# 2026-08-04：【落盘说明】横幅已撤（与完成态叠放净负）；检测器保留；不做完成态降档。
# Soft only: prefix banner, never discard/reject the turn. Prompt is primary;
# this catches high-confidence 「假已改 / 甩整文件手贴」when this turn has no write evidence.
# Deliberately narrow — bare「已处理」/「可用了」不进表，避免误伤核对与解释。

_CEO_MUTATION_DONE_CLAIMS = re.compile(
    r"(?:"
    r"已(?:成功)?(?:修改|修正|改好|改完|改妥)|"
    r"(?:代码|文件|源码)已(?:修改|修正|改好|更新|落盘)|"
    r"已将.{0,24}(?:修改|写入|落盘|更新)到|"
    r"✅\s*已(?:改|修改|修正)|"
    r"修改已完成|修正已完成|改动已落地"
    r")"
)

_CEO_WHOLE_FILE_PASTE = re.compile(
    r"(?:"
    r"请(?:你)?(?:自己|自行).{0,12}(?:替换|粘贴|覆盖).{0,24}整(?:个|份)?文件|"
    r"请(?:把|将).{0,20}整(?:个|份)?文件.{0,16}(?:粘贴|替换|覆盖)|"
    r"自己替换整文件|整文件自行(?:替换|粘贴)|"
    r"请(?:把|将)?下面.{0,20}完整.{0,12}(?:粘贴|替换).{0,16}(?:覆盖|文件)|"
    r"手动(?:把|将)?.{0,12}整(?:份|个)?(?:文件|代码).{0,12}粘贴"
    r")"
)

def claims_ceo_mutation_done(content: str) -> bool:
    """True when CEO prose claims this-turn file mutation completed.

    Detector kept for tests / future gates; soft banner path withdrawn 2026-08-04.
    """
    return _positive_hits(_CEO_MUTATION_DONE_CLAIMS, content or "")


def asks_whole_file_user_paste(content: str) -> bool:
    """True when CEO asks the user to paste/replace a whole file themselves."""
    return bool(_CEO_WHOLE_FILE_PASTE.search(content or ""))


def turn_has_product_write_evidence(*, landing_succeeded: bool = False) -> bool:
    """Whether this turn has product write evidence (CEO landing or accepted delivery files)."""
    if landing_succeeded:
        return True
    from agentcore.runtime.delegate.delivery_status import current_delivery_verdict

    verdict = current_delivery_verdict.get()
    if verdict is None:
        return False
    return bool(verdict.delivered_files)


def enforce_ceo_mutation_honesty(
    content: str,
    *,
    landing_succeeded: bool = False,
) -> str:
    """No-op: 【落盘说明】soft banner withdrawn (2026-08-04).

    Prefixing a hardcoded warning while leaving model「已落盘/已验收」intact caused
    conflicting status in-bubble (sample 92e9dcaa). Boarded: delete banner only;
    no completion-claim downgrade. ``landing_succeeded`` retained for call-site compat.
    """
    _ = landing_succeeded
    return content or ""


# --- Cloud Web install/verify honesty (案 20260803-cloud-web-install-deny-claim-verified · A+B) ---
# Soft only: prefix banner when this turn had structured install deny / verify gap
# and prose claims「自检全过 / 跑绿 / 全部通过」. Never discard/reject. Separate axis
# from softⅡ′ (zero-write), ppt-office, and image-gen egress.

_turn_cloud_web_verify_gap: ContextVar[bool] = ContextVar(
    "turn_cloud_web_verify_gap", default=False
)

_CLOUD_WEB_VERIFY_GREEN_CLAIMS = re.compile(
    r"(?:"
    r"自检(?:链路)?全部通过|自检全过|"
    r"(?:后端)?单测已(?:跑)?绿|测试已跑绿|已跑绿|跑绿|"
    r"测试全部通过|全部测试通过|"
    r"沙箱内.{0,32}全部通过|"
    r"全部通过"
    r")"
)

_CLOUD_WEB_VERIFY_HONESTY_BANNER = (
    "【验证说明】本回合有装包被拒或外环验证缺口——下文若写「自检全过 / 跑绿 / 全部通过」，"
    "可能把结构自检说成了外环验绿。云端不能代跑 install→build/test 时，请标明未装包/"
    "未外环验绿，并给出本机命令或 export_to_local。\n\n"
)


def note_cloud_web_verify_gap() -> None:
    """Latch turn-scoped install-deny / verify-gap evidence (survives batch overwrite)."""
    _turn_cloud_web_verify_gap.set(True)


def clear_cloud_web_verify_gap() -> None:
    """Reset at turn entry (fresh arm / resume wire)."""
    _turn_cloud_web_verify_gap.set(False)


def turn_has_cloud_web_verify_gap() -> bool:
    """True when this turn noted structured install deny or verify gap."""
    return bool(_turn_cloud_web_verify_gap.get())


def claims_cloud_web_verify_green(content: str) -> bool:
    """True when prose asserts install→build/test all-green (closed set)."""
    return _positive_hits(_CLOUD_WEB_VERIFY_GREEN_CLAIMS, content or "")


def note_cloud_web_verify_gap_from_delivery(
    gaps: list[Any] | None = None,
    *,
    criteria_gaps: list[str] | None = None,
) -> None:
    """Stamp latch from delivery_status gaps / soft verify overlay notes."""
    for gap in gaps or []:
        if not isinstance(gap, dict):
            text = str(gap or "")
            if _delivery_text_implies_verify_gap(text):
                note_cloud_web_verify_gap()
                return
            continue
        reason = str(gap.get("reason") or "").strip()
        if reason == "verify_failed":
            note_cloud_web_verify_gap()
            return
        if _delivery_text_implies_verify_gap(str(gap.get("description") or "")):
            note_cloud_web_verify_gap()
            return
    for note in criteria_gaps or []:
        if _delivery_text_implies_verify_gap(str(note or "")):
            note_cloud_web_verify_gap()
            return


def _delivery_text_implies_verify_gap(text: str) -> bool:
    t = text or ""
    if not t:
        return False
    if "无法装包" in t:
        return True
    if "建议补一次验证" in t:
        return True
    if "测试未通过" in t or "验证命令未通过" in t:
        return True
    return "browser_navigate 未成功" in t


def enforce_cloud_web_verify_honesty(content: str) -> str:
    """Prefix honesty banner when green claims meet install-deny / verify-gap latch.

    Does not rewrite or block the turn — soft backstop only (案 B).
    """
    text = content or ""
    if not turn_has_cloud_web_verify_gap():
        return text
    if not claims_cloud_web_verify_green(text):
        return text
    stripped = text.lstrip()
    if stripped.startswith("【验证说明】"):
        return text
    return _CLOUD_WEB_VERIFY_HONESTY_BANNER + text


def downgrade_verdict_for_ceiling(*, reason: str = "max_rounds") -> None:
    """Mark delivery informal when CEO hits a hard ceiling (cannot stay ``delivered``)."""
    from agentcore.runtime.delegate.delivery_status import (
        DeliveryVerdict,
        current_delivery_verdict,
    )

    r = (reason or "").strip() or "max_rounds"
    if r not in _CEILING_HONESTY_REASONS:
        r = "max_rounds"
    verdict = current_delivery_verdict.get()
    if verdict is None:
        current_delivery_verdict.set(
            DeliveryVerdict(
                state="partial",
                delivered_files=(),
                execution_id=f"ceiling_{r}",
            )
        )
        return
    if not is_formal_complete_tier(verdict.state):
        return
    current_delivery_verdict.set(
        DeliveryVerdict(
            state="partial",
            delivered_files=verdict.delivered_files,
            execution_id=verdict.execution_id,
            requires_draft_ack=verdict.requires_draft_ack,
        )
    )


def downgrade_verdict_for_max_rounds() -> None:
    """Alias: mark informal when CEO hits max_rounds."""
    downgrade_verdict_for_ceiling(reason="max_rounds")


# --- Cutoff / token_budget delivery honesty (定稿漂移 B′ · CEO 综收软横幅) ---
# Truth source = structured writing-cutoff gap reasons (or turn-token skip), not
# posture-A word expansion. 「完整落盘 / 六章全部」常不进姿势 A 闭集；靠档位/缺口 latch
# 软横幅，禁止把那些词扩进硬拒表。

_CUTOFF_DELIVERY_GAP_REASONS = frozenset(
    {"token_budget", "worker_timeout", "turn_token_budget"}
)

_turn_cutoff_delivery_gap: ContextVar[bool] = ContextVar(
    "turn_cutoff_delivery_gap", default=False
)

_CUTOFF_CLOSING_HONESTY_BANNER = (
    "【收口说明】本回合存在预算/掐断类交付缺口（对账为部分交付），"
    "以下不得视为无条件完整收卷——"
    "请按「部分交付 + 未闭合项」理解。\n\n"
)

# Positive skip markers: already framed as partial — do not stack the banner.
_CUTOFF_HONEST_PARTIAL_MARKERS = ("部分交付", "部分落地", "尚未齐备", "未闭合")


def note_cutoff_delivery_gap() -> None:
    """Latch turn-scoped writing-cutoff / token-budget gap evidence."""
    _turn_cutoff_delivery_gap.set(True)


def clear_cutoff_delivery_gap() -> None:
    """Reset at turn entry (fresh arm / resume wire)."""
    _turn_cutoff_delivery_gap.set(False)


def turn_has_cutoff_delivery_gap() -> bool:
    """True when this turn noted structured cutoff / token_budget delivery gaps."""
    return bool(_turn_cutoff_delivery_gap.get())


def note_cutoff_delivery_gap_from_delivery(
    gaps: list[Any] | None = None,
) -> None:
    """Stamp latch from delivery_status gaps with writing-cutoff / budget reasons."""
    for gap in gaps or []:
        if not isinstance(gap, dict):
            continue
        reason = str(gap.get("reason") or "").strip()
        if reason in _CUTOFF_DELIVERY_GAP_REASONS:
            note_cutoff_delivery_gap()
            return


def enforce_cutoff_closing_honesty(content: str) -> str:
    """Prefix soft banner when structured cutoff/partial latch is set.

    Soft only — never discards/rejects. Not gated on posture A (those claims often
    sit outside the closed set for this case). Skips when prose already frames
    partial delivery. Does **not** expand the posture-A word list.
    """
    text = content or ""
    if not turn_has_cutoff_delivery_gap():
        return text
    stripped = text.lstrip()
    if stripped.startswith("【收口说明】"):
        return text
    if claims_draft_acknowledgment(text):
        return text
    if any(m in text for m in _CUTOFF_HONEST_PARTIAL_MARKERS):
        return text
    return _CUTOFF_CLOSING_HONESTY_BANNER + text

# --- Unresolved write-ownership honesty (案 20260804-ghost-owner-nested-lookup · P0-B) ---
# Structured only: claim-denied paths still held by another owner → latch + verdict
# downgrade. Soft banner uses existing posture-A closed set. **禁止**扫「定稿|闭环」正文。

_turn_unresolved_write_ownership: ContextVar[bool] = ContextVar(
    "turn_unresolved_write_ownership", default=False
)
_turn_write_ownership_refused_runs: ContextVar[frozenset[str]] = ContextVar(
    "turn_write_ownership_refused_runs", default=frozenset()
)

_WRITE_OWNERSHIP_HONESTY_BANNER = (
    "【写权说明】本回合有未解写权冲突——下文若宣称完整交付 / 全员收卷 / "
    "已完整可用，可能不准确。请按部分完成收口并点名未移交或未落盘路径。\n\n"
)


def note_unresolved_write_ownership(*, run_id: str | None = None) -> None:
    """Latch turn-scoped unresolved write-collision / ownership-conflict evidence."""
    _turn_unresolved_write_ownership.set(True)
    rid = (run_id or "").strip()
    if rid:
        prev = _turn_write_ownership_refused_runs.get()
        _turn_write_ownership_refused_runs.set(prev | {rid})


def clear_unresolved_write_ownership() -> None:
    """Reset at turn entry (fresh arm / resume wire)."""
    _turn_unresolved_write_ownership.set(False)
    _turn_write_ownership_refused_runs.set(frozenset())


def turn_has_unresolved_write_ownership() -> bool:
    """True when this turn noted unresolved write-ownership conflict."""
    return bool(_turn_unresolved_write_ownership.get())


def collect_unresolved_write_ownership_paths(
    *,
    execution_id: str | None = None,
    run_ids: set[str] | frozenset[str] | list[str] | None = None,
    coordinator: Any = None,
) -> tuple[str, ...]:
    """Paths still owned by someone other than a run that was refused on claim.

    Uses public ledger APIs only (``denied_paths_for`` / ``owner_of``). Empty when
    the book has no lingering conflict (e.g. after structured transfer).
    """
    coord = coordinator
    if coord is None:
        try:
            from agentcore.workspace.write_claims import resolve_write_coordinator

            coord = resolve_write_coordinator(execution_id=execution_id)
        except Exception:  # noqa: BLE001 — honesty side channel must never raise
            return ()
    if coord is None:
        return ()
    ids = {
        str(rid).strip()
        for rid in (run_ids or ())
        if rid is not None and str(rid).strip()
    }
    if not ids:
        return ()
    out: list[str] = []
    seen: set[str] = set()
    try:
        for rid in ids:
            for path in coord.denied_paths_for(rid):
                key = str(path or "").strip()
                if not key or key in seen:
                    continue
                owner = coord.owner_of(key)
                if owner and owner != rid:
                    seen.add(key)
                    out.append(key)
    except Exception:  # noqa: BLE001
        return ()
    return tuple(out)


def reconcile_unresolved_write_ownership_latch(
    *,
    execution_id: str | None = None,
    run_ids: set[str] | frozenset[str] | list[str] | None = None,
    coordinator: Any = None,
) -> tuple[str, ...]:
    """Recompute latch from the ledger; clear when scanned refusals are all resolved."""
    refused = set(_turn_write_ownership_refused_runs.get())
    scanned = {
        str(rid).strip()
        for rid in (run_ids or ())
        if rid is not None and str(rid).strip()
    } | refused
    if not scanned and coordinator is None and not (execution_id or "").strip():
        # Cannot recompute — leave sticky latch alone for finish_guard belt.
        return ()
    paths = collect_unresolved_write_ownership_paths(
        execution_id=execution_id,
        run_ids=scanned or None,
        coordinator=coordinator,
    )
    if paths:
        note_unresolved_write_ownership()
        return paths
    if scanned:
        # Live scan found nothing lingering — drop sticky collision latch.
        clear_unresolved_write_ownership()
    return ()


def note_unresolved_write_ownership_from_ledger(
    *,
    execution_id: str | None = None,
    run_ids: set[str] | frozenset[str] | list[str] | None = None,
    coordinator: Any = None,
) -> tuple[str, ...]:
    """Stamp or clear latch from ledger scan. Returns still-unresolved paths."""
    return reconcile_unresolved_write_ownership_latch(
        execution_id=execution_id,
        run_ids=run_ids,
        coordinator=coordinator,
    )


def run_ids_for_write_ownership_scan(
    *,
    plan: Any = None,
    results: dict[str, Any] | None = None,
    session: Any = None,
) -> set[str]:
    """Collect run_ids that may have claim-denials (plan / results / session workers)."""
    ids: set[str] = set()
    nodes = getattr(plan, "nodes", None) if plan is not None else None
    if nodes:
        for node in nodes:
            rid = (getattr(node, "run_id", None) or "").strip()
            if rid:
                ids.add(rid)
    if results:
        for rid in results:
            key = str(rid or "").strip()
            if key:
                ids.add(key)
    if session is not None:
        live = getattr(session, "live_plan", None)
        live_nodes = getattr(live, "nodes", None) if live is not None else None
        if live_nodes:
            for node in live_nodes:
                rid = (getattr(node, "run_id", None) or "").strip()
                if rid:
                    ids.add(rid)
        for rid in getattr(session, "completed_run_ids", ()) or ():
            key = str(rid or "").strip()
            if key:
                ids.add(key)
        running = getattr(session, "running_workers", None)
        if callable(running):
            for rid, _role in running():
                key = str(rid or "").strip()
                if key:
                    ids.add(key)
    return ids


def downgrade_verdict_for_unresolved_write_ownership(
    *,
    execution_id: str | None = None,
    run_ids: set[str] | frozenset[str] | list[str] | None = None,
    coordinator: Any = None,
) -> None:
    """Internal honesty: unresolved write ownership → cannot stay ``delivered``.

    Reconciles sticky collision latch against the live ledger when possible.
    Does not scan user/synthesis prose for 「定稿|闭环」. Soft banner is separate.
    """
    reconcile_unresolved_write_ownership_latch(
        execution_id=execution_id,
        run_ids=run_ids,
        coordinator=coordinator,
    )
    if not turn_has_unresolved_write_ownership():
        return
    from agentcore.runtime.delegate.delivery_status import (
        DeliveryVerdict,
        current_delivery_verdict,
    )

    verdict = current_delivery_verdict.get()
    eid = (execution_id or "").strip() or "write_ownership_conflict"
    if verdict is None:
        current_delivery_verdict.set(
            DeliveryVerdict(
                state="partial",
                delivered_files=(),
                execution_id=eid,
            )
        )
        return
    if not is_formal_complete_tier(verdict.state):
        return
    current_delivery_verdict.set(
        DeliveryVerdict(
            state="partial",
            delivered_files=verdict.delivered_files,
            execution_id=verdict.execution_id,
            requires_draft_ack=verdict.requires_draft_ack,
        )
    )


def apply_write_ownership_honesty_for_session(session: Any) -> tuple[str, ...]:
    """Re-stamp latch + downgrade when adopting a live coordination session (harvest)."""
    if session is None:
        return ()
    coord = getattr(session, "file_ownership", None)
    if coord is None:
        return ()
    eid = (getattr(session, "execution_id", None) or "").strip() or None
    paths = note_unresolved_write_ownership_from_ledger(
        execution_id=eid,
        run_ids=run_ids_for_write_ownership_scan(session=session),
        coordinator=coord,
    )
    if paths:
        downgrade_verdict_for_unresolved_write_ownership(
            execution_id=eid,
            run_ids=run_ids_for_write_ownership_scan(session=session),
            coordinator=coord,
        )
    return paths


def enforce_write_ownership_honesty(content: str) -> str:
    """Prefix soft banner when unresolved write ownership meets posture-A claims.

    Soft only — never discards/rejects the turn; does not expand 「定稿」词表.
    """
    text = content or ""
    if not turn_has_unresolved_write_ownership():
        return text
    if not claims_posture_a(text):
        return text
    stripped = text.lstrip()
    if stripped.startswith("【写权说明】") or stripped.startswith("【收口说明】"):
        return text
    if stripped.startswith("【落盘说明】") or stripped.startswith("【验证说明】"):
        return text
    return _WRITE_OWNERSHIP_HONESTY_BANNER + text
