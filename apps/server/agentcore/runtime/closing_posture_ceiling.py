"""Hard-ceiling honesty steer / banner + informal verdict downgrade.

Covers ``max_rounds`` and ``token_budget`` symmetrically (worker salvage + CEO).
Does **not** expand the posture-A closed set.
"""

from __future__ import annotations

from agentcore.runtime.closing_posture_core import (
    claims_posture_a,
    is_formal_complete_tier,
)
from agentcore.runtime.closing_posture_hollow import (
    _CEILING_HOLLOW_TEACH_BANNER,
    claims_hollow_teach_invite,
)

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
        "【禁止】空心邀请用户「请开讲 / 请讲 / 我在听」——须点名硬顶未闭合项；"
        "须按「部分落地 + 未闭合项」收口：点名已落地与未闭合，勿假装验收过关。"
        "有交付对账卡时以档位为准；非正式完成不得姿势 A。"
    )


def enforce_ceiling_closing_honesty(content: str, *, reason: str) -> str:
    """Deterministic backstop: ceiling salvage still claiming posture A → banner.

    force_finalize bypasses finish_guard; when the model ignores
    :func:`ceiling_honesty_steer`, prefix a short honesty note instead of
    shipping an unconditional pass claim. ``max_rounds`` / ``token_budget`` share
    this path; does **not** expand the posture-A closed set.
    Also banners hollow teach-invites（请开讲）after ceiling（案 1eb5eb99 C）.
    """
    text = content or ""
    r = (reason or "").strip()
    banner = _CEILING_HONESTY_BANNERS.get(r)
    if banner is None:
        return text
    stripped = text.lstrip()
    if stripped.startswith("【收口说明】"):
        return text
    if claims_posture_a(text):
        return banner + text
    if claims_hollow_teach_invite(text):
        return _CEILING_HOLLOW_TEACH_BANNER + text
    return text


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
