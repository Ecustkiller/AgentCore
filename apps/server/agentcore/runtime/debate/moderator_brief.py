"""收场简报 —— 决策简报产物。

从 Moderator 拆出的「书记收场」职责。→ 见设计: docs/03-AI核心/辩论编排设计.md §二
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.debate.moderator_common import (
    _SUMMARY_CLIP,
    _TURN_CLIP,
    CompleteJson,
    _as_str,
    _as_str_list,
    _clip,
    _sides_block,
    _turns_block,
)
from agentcore.runtime.debate.types import (
    DebateBrief,
    DebateConfig,
    DebateForm,
    RoundResult,
    RoundScore,
    tally_scores,
)

logger = get_logger(__name__)

_BRIEF_SYSTEM = (
    "你是一场结构化辩论的主持人。辩论收场时你产出【决策简报】，为用户的决策负责到底：去水提炼"
    "各方最强论点、区分【事实分歧】（可据证据帮判）与【价值/偏好分歧】（必须交用户定）、给出带"
    "置信度与成立条件的倾向判断。【决定性事实若只有二手来源 / 仍待核实，须在结论里保留其证据状态、"
    "不抹成既定事实】——宁可诚实降置信度，不可拿未核实的事实当定论。"
    "务实、诚实，不回避不确定性。严格只输出要求的 JSON。"
)

_SEVERITY_VALUES = {"high", "medium", "low"}
_SEVERITY_ALIASES = {
    "高": "high",
    "中": "medium",
    "低": "low",
    "critical": "high",
    "severe": "high",
    "major": "high",
    "moderate": "medium",
    "minor": "low",
}


def _brief_form_hint(form: DebateForm) -> str:
    """各形态「简报该产出什么」的差异指引（喂给 :func:`build_brief`）。

    呼应 :attr:`DebateResult.narrative_first`：决策类（正反/红队）简报先行、为决策负责；
    探讨类（圆桌）过程先行、简报是观点地图小结。"""
    if form is DebateForm.RED_TEAM:
        return (
            "这是【红队挑刺】：简报应是【风险清单 + 加固建议】——把挖出的风险按严重度梳理、"
            "标明哪些方案方已修补、哪些仍是 open 风险需用户决断。"
        )
    if form is DebateForm.ROUNDTABLE:
        return (
            "这是【多方圆桌】：简报应是【观点地图小结】——铺出观点光谱全貌、各视角的独特定位与"
            "其成立前提，而非强行裁谁对谁错；末尾点出值得用户进一步思考的开放问题。"
        )
    return (
        "这是【正反辩论】：简报要为用户的【决策】负责到底——给出带置信度与反转条件的倾向判断 + "
        "具体建议，而非把正反并排甩给用户让他自己选。"
    )


def _interjections_block(rounds: Sequence[RoundResult]) -> str:
    """全场用户追问块（喂给 :func:`build_brief`）—— 把各轮承接的用户追问按轮汇总，让简报
    【交代是否已回应】（未应答的进 open_questions）。无追问返回空串（简报 prompt 不变、零变化）。"""
    items: list[str] = []
    for rr in rounds:
        for i in rr.user_interjections:
            target = f"（向 {i.target_key}）" if i.target_key else "（向全场）"
            state = "已在该轮请辩手回应" if i.answered else "未及回应"
            items.append(f"- 第 {rr.round_no} 轮{target}：{i.ask} — {state}")
    if not items:
        return ""
    body = "\n".join(items)
    return (
        "辩论过程中用户提出的【追问】（你的简报须交代是否已被回应；仍未答清的须进 "
        f"open_questions / recommendation，别让用户的问题石沉大海）：\n{body}\n\n"
    )


def _scores_block(config: DebateConfig, tally: dict[str, RoundScore]) -> str:
    """把全场累计记分渲染进简报 prompt（记分裁判 P2）。

    对抗形态：收场 decisive / leaning 须与累计记分对齐。圆桌：仅作 momentum 展示，
    不驱动 leaning、不裁胜负（与质询/结辩同属形态门控口径）。无记分返回空串。
    """
    if not tally:
        return ""
    lines: list[str] = []
    for s in config.sides:
        sc = tally.get(s.key)
        if sc is None:
            continue
        pen = f"，罚 {len(sc.penalties)}（{'；'.join(sc.penalties)}）" if sc.penalties else ""
        lines.append(
            f"- {s.name}[{s.key}]：论点 {sc.argument} + 回应 {sc.engagement} + 证据 {sc.evidence}"
            f"{pen} = 净分 {sc.total}"
        )
    if not lines:
        return ""
    body = "\n".join(lines)
    if config.form is DebateForm.ROUNDTABLE:
        return (
            "各方【累计记分】（裁判逐轮打分之和；仅作【momentum 展示】——"
            "圆桌不裁胜负，勿用记分驱动 leaning / decisive、勿据此点名赢家）：\n"
            f"{body}\n\n"
        )
    return (
        "各方【累计记分】（裁判逐轮打分之和；你的 decisive / leaning 须与它一致——净分更高 / 罚分"
        f"更少的一方更站得住，相悖须说明为何）：\n{body}\n\n"
    )


def _as_str_dict(value: Any) -> dict[str, str]:
    """把 strongest_points 规整为 {side_key: str}（容忍 LLM 返回 list[{key,point}] 等变体）。"""
    if isinstance(value, dict):
        return {str(k): _as_str(v) for k, v in value.items() if _as_str(v)}
    if isinstance(value, list):
        out: dict[str, str] = {}
        for item in value:
            if isinstance(item, dict):
                key = _as_str(item.get("key") or item.get("side") or item.get("side_key"))
                point = _as_str(item.get("point") or item.get("argument") or item.get("value"))
                if key and point:
                    out[key] = point
        return out
    return {}


def _as_severity_dict(value: Any) -> dict[str, str]:
    """把 risk_severities 规整为 {side_key: high|medium|low}（容忍中文/同义词/list 变体）。

    只收 high/medium/low 三档，非法档位丢弃——前端风险看板只认这三档分级。
    """

    def _norm(raw: Any) -> str:
        token = _as_str(raw).strip().lower()
        token = _SEVERITY_ALIASES.get(token, token)
        return token if token in _SEVERITY_VALUES else ""

    if isinstance(value, dict):
        out = {str(k): _norm(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v}
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            if isinstance(item, dict):
                key = _as_str(item.get("key") or item.get("side") or item.get("side_key"))
                sev = _norm(item.get("severity") or item.get("level") or item.get("value"))
                if key and sev:
                    result[key] = sev
        return result
    return {}


async def build_brief(
    complete_json: CompleteJson,
    config: DebateConfig,
    rounds: list[RoundResult],
) -> DebateBrief:
    """收场产出决策简报（结论产物）。"""
    if not rounds:
        return DebateBrief(
            crux=config.motion, recommendation="辩论未产生有效轮次，无法形成简报。"
        )
    timeline = "\n".join(
        f"第 {rr.round_no} 轮（{rr.focus}）：{_clip(rr.summary, _SUMMARY_CLIP)}"
        for rr in rounds
    )
    # 用户追问（交互式逐轮）：把全场用户注入的问题喂进简报，让结论【交代是否已回应】——未应答的
    # 追问应进 open_questions（仅剩需你拍板/查证的点），别让用户的问题石沉大海。无追问则省略。
    followups_block = _interjections_block(rounds)
    # 记分裁判（P2）：全场累计记分喂进简报。对抗形态让 decisive / leaning 与交锋对齐；
    # 圆桌仅作 momentum（见 _scores_block）。无记分则空块，简报零变化。
    scores_block = _scores_block(config, tally_scores(rounds))
    last_turns = _turns_block(rounds[-1].ok_turns, clip=_TURN_CLIP)
    sides_keys = ", ".join(s.key for s in config.sides)
    is_red_team = config.form is DebateForm.RED_TEAM
    is_roundtable = config.form is DebateForm.ROUNDTABLE
    # 红队专用：让简报给每条风险（红队成员，不含被审方案方）评严重度，驱动前端「风险看板」
    # 分级 + 总览计数。其余形态不要这个字段（风险严重度对正反/圆桌无意义）。
    severity_field = (
        f'  "risk_severities": {{"<红队成员 side_key∈[{sides_keys}]>": "high|medium|low"}},\n'
        if is_red_team
        else ""
    )
    severity_note = (
        "（红队：在 risk_severities 里给每个红队成员的风险按【影响后果 × 发生可能性】评"
        "high/medium/low，让用户先看高危；被审方案方不评级。）"
        if is_red_team
        else ""
    )
    if is_roundtable:
        score_align_note = (
            "若上方给了【累计记分】，仅作 momentum 参考、【不】驱动 leaning / decisive、"
            "【不】裁谁对谁错；decisive 可留空或写「无胜负手（圆桌）」；leaning 写观点光谱"
            "小结而非点名赢家。"
        )
        decisive_field = '  "decisive": "圆桌无胜负手：可留空或写「无胜负手（圆桌）」",\n'
        leaning_field = (
            '  "leaning": "观点光谱小结（各视角成立前提与张力，非裁出赢家）",\n'
        )
    else:
        score_align_note = (
            "若上方给了【累计记分】，你的 decisive / leaning 必须与它一致"
            "（净分更高 / 罚分更少的一方更站得住；若倾向与记分相悖须在 confidence 里说明为何）；"
        )
        decisive_field = (
            '  "decisive": "胜负手：一句话点名谁的哪个论点被 drop / 证伪 / 无据，据此定倾向",\n'
        )
        leaning_field = (
            '  "leaning": "你的倾向性判断（基于事实与累计记分哪方更站得住）",\n'
        )
    user = (
        f"辩论命题：{config.motion}\n参与方：\n{_sides_block(config)}\n\n"
        f"各轮推进：\n{timeline}\n\n{scores_block}{followups_block}最后一轮各方发言：\n{last_turns}\n\n"
        f"{_brief_form_hint(config.form)}\n"
        "请据此产出简报，为用户负责到底（不要只把各方观点并排甩给他）：各方最强论点要"
        f"【去水压成单句、只留命门】；{score_align_note}"
        "leaning / confidence 还要写清【反转条件】（在什么前提下倾向会翻）。"
        "【关键事实的证据状态必须继承到结论、不得在收尾抹平】：若 decisive / leaning 依赖的某个"
        "关键事实在辩论里是【待核实】或仅【单一二手来源】，不得把它当既定事实来定倾向——要么在 "
        "confidence 里显式降级并标【需一手核实】，要么把它移进 factual_disputes / open_questions；"
        "结论文字里引用这类事实时【保留证据状态词】（如「若 X 属实——目前仅二手报道、待一手核实——"
        f"则…」）、别写成板上钉钉。{severity_note}只输出 JSON：\n"
        "{\n"
        '  "crux": "双方真正的争议焦点在哪",\n'
        f'  "strongest_points": {{"<side_key∈[{sides_keys}]>": "该方去水后的最强论点"}},\n'
        f"{severity_field}"
        '  "factual_disputes": ["关键【事实】分歧（可据证据帮判的）"],\n'
        '  "value_disputes": ["【价值/偏好】分歧（AI 判不了、必须交用户定的）"],\n'
        f"{decisive_field}"
        f"{leaning_field}"
        '  "confidence": "置信度及其成立条件（说明在什么前提下倾向会反转）",\n'
        '  "recommendation": "给用户的具体建议",\n'
        '  "open_questions": ["仅剩需用户拍板的点"]\n'
        "}"
    )
    data = await complete_json(_BRIEF_SYSTEM, user, "brief")
    if not data:
        # 容错降级：用最后一轮小结拼一个最小简报，别让坏 JSON 吞掉整场结论。
        logger.warning("debate.brief.parse_failed", rounds=len(rounds))
        return DebateBrief(
            crux=rounds[0].focus or config.motion,
            recommendation=rounds[-1].summary or "简报生成失败，请查看逐轮交锋。",
        )
    return DebateBrief(
        crux=_as_str(data.get("crux")) or config.motion,
        strongest_points=_as_str_dict(data.get("strongest_points")),
        # 严重度仅红队形态有意义：非红队即便 LLM 误填也丢弃，保证载荷干净。
        risk_severities=(
            _as_severity_dict(data.get("risk_severities")) if is_red_team else {}
        ),
        factual_disputes=_as_str_list(data.get("factual_disputes")),
        value_disputes=_as_str_list(data.get("value_disputes")),
        decisive=_as_str(data.get("decisive")),
        leaning=_as_str(data.get("leaning")),
        confidence=_as_str(data.get("confidence")),
        recommendation=_as_str(data.get("recommendation")),
        open_questions=_as_str_list(data.get("open_questions")),
    )
