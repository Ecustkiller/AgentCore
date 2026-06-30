"""辩手 prompt 构造（首轮 task + 后续轮 feedback）。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agentcore.runtime.debate import (
    DebateConfig,
    DebateForm,
    DebateSeed,
    DebateSide,
    RoundResult,
    UserInterjection,
)
from agentcore.tools.builtin.debate.schema import (
    DEBATER_TOOLS,
    FORM_LABELS,
    LENGTH_HINT,
    QUICK_DEBATER_HINT,
)

# 后续轮把【对手上一轮发言】喂回本辩手时，每份的头尾截断上限。多方圆桌每轮要塞 N-1 份对手
# 全文，不裁会让 prompt 暴涨、烧钱且稀释焦点（主持人侧 judge/brief 早已 _clip，唯独喂辩手没裁）。
# 头尾保留：对手的立论（头）与结论（尾）都留，只挖中段——辩手看要旨足以针对性回应。
_OPP_CLIP = 1500


def _clip(text: str, limit: int = _OPP_CLIP) -> str:
    """头尾保留地截断（与主持人 ``moderator._clip`` 同思路）。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    half = max(1, (limit - 20) // 2)
    return f"{text[:half]}\n……（中段略）……\n{text[-half:]}"


def role_directive(config: DebateConfig, side: DebateSide) -> str:
    """按形态 / 角色给辩手的差异化指引。"""
    if config.form is DebateForm.RED_TEAM:
        if side.is_subject:
            return (
                "（你是被审视的方案方：红队会单向施压找你的漏洞，你的职责是诚实回应、能修补"
                "就给出修补、修不了的风险要坦白承认，不要嘴硬。）"
            )
        return (
            "（你是红队：职责是尽力挖出该方案的风险、漏洞、失败场景与边界条件，单向施压，"
            "不需要你自己另提方案。）"
        )
    if config.form is DebateForm.ROUNDTABLE:
        return (
            "（这是多方圆桌：你代表一个特定视角，平等陈述并回应他人，目标是铺满观点光谱、"
            "贡献你这一视角独有的洞察，而非压倒对方。）"
        )
    return "（这是正反辩论：直接攻防，针锋相对地回应对方最强论点。）"


def side_system(config: DebateConfig, side: DebateSide) -> str:
    base = (
        f"你是一场结构化辩论中的辩手，代表「{side.name}」。坚定但理性地为你的立场辩护："
        "论据具体、直面对方、不偷换概念、不因篇幅长而堆砌；用具体证据 / 例子 / 推理链支撑论点，"
        "而非泛泛断言或空喊口号。"
    )
    return f"{base}{role_directive(config, side)}"


def seed_block(seed: DebateSeed | None, side: DebateSide) -> str:
    """续辩（结构化补轮·B）首轮辩手的「上一场摘要」块——让本方读懂上一场后【接着往深里辩】。

    只喂【事实性的过程摘要】（逐轮焦点/小结 + 本方上一场最强论点 + 仍未决的分歧 + 争议焦点），
    **刻意不喂主持人的倾向判断 leaning**（那是裁判口径，喂给辩手会污染新一场的中立性）。无种子
    返回空串（首轮 task 不变、逐字回退到全新辩论）。"""
    if seed is None:
        return ""
    parts: list[str] = []
    if seed.rounds:
        arc = "\n".join(
            f"- 第 {r.round_no} 轮 · {r.focus}：{r.summary}" for r in seed.rounds if r.focus or r.summary
        )
        if arc:
            parts.append(f"上一场各轮交锋：\n{arc}")
    mine = seed.strongest_points.get(side.key, "")
    if mine:
        parts.append(f"你（{side.name}）上一场最强论点：{mine}")
    if seed.crux:
        parts.append(f"上一场争议焦点：{seed.crux}")
    unresolved = list(seed.value_disputes) + list(seed.open_questions)
    if unresolved:
        parts.append("上一场仍【未决】的分歧（本场请往这些上面推进）：\n" + "\n".join(f"- {u}" for u in unresolved))
    if not parts:
        return ""
    body = "\n\n".join(parts)
    return (
        "\n\n【这是续辩——接着上一场辩论往深里辩】\n"
        f"{body}\n"
        "请在上一场的基础上提出【新的】论点或更深一层的论证，别重复上一场已说透的内容。\n"
    )


def debater_task(
    config: DebateConfig,
    side: DebateSide,
    idx: int,
    *,
    round_no: int,
    focus: str,
    seed: DebateSeed | None = None,
) -> dict[str, Any]:
    """构造首轮单个辩手的 task dict（build_run_plan 入参）。

    ``seed`` 非空时（结构化补轮·B）注入上一场摘要块，让本方从「读懂上一场」处接着辩。"""
    # 快速对碰：注入轻量约束压住「为小题深挖」（少检索、收窄论点）；认真辩透则不加。
    quick_suffix = "" if config.policy.thorough else f"\n{QUICK_DEBATER_HINT}"
    prior = seed_block(seed, side)
    task = (
        f"你在一场【{FORM_LABELS.get(config.form, '辩论')}】中代表「{side.name}」。\n"
        f"辩论命题：{config.motion}\n"
        f"你的立场 / 视角：{side.stance}\n"
        f"本轮议题：{focus}\n\n"
        f"{role_directive(config, side)}{prior}\n"
        f"请就本轮议题给出有力、具体、有论据的论证（这是你的开场立论）：聚焦你最能站住的论点，"
        f"用具体证据 / 例子 / 推理链支撑（必要时用 web_search / read_url 取证）。{LENGTH_HINT}{quick_suffix}"
    )
    payload: dict[str, Any] = {
        "role": side.name,
        "task": task,
        "objective": f"代表「{side.name}」就「{focus}」立论",
        "system_prompt_supplement": side_system(config, side),
        "model_preference": config.model_preference,
        "tools": list(DEBATER_TOOLS),
        "group": f"debate:{config.form.value}",
        "round": round_no,
    }
    # 真·多模型辩手：该方若指定了模型，透传给 RunSpec.model（→ 执行器覆写 profile.model →
    # 路由器按 provider/model 前缀分发到对应厂商）。留空则不带此键，按 tier 解析默认模型。
    # 后续轮 continue_run 复用首轮 session.spec（已带 model），故同一辩手跨轮恒走同一模型。
    if side.model:
        payload["model"] = side.model
    # stance 仅正反 2 方有意义（builder 只认 pro/con，display-only）。
    if config.form is DebateForm.DEBATE and len(config.sides) == 2:
        payload["stance"] = "pro" if idx == 0 else "con"
    return payload


def _challenged_block(config: DebateConfig, side: DebateSide, last_round: RoundResult) -> str:
    """上一轮裁判抽出的「谁驳了本方、驳在哪」（``to_key==本方`` 的 clash 边）——喂回辩手让它
    【精准回应被攻击的命门】（B2）。与主持人侧 clash 强化形成正反馈：辩手正面接招 → 下一轮交锋
    更针锋相对 → 裁判抽 clash 更干净。无指向本方的边时返回空串（跳过、不硬塞）。"""
    names = {s.key: s.name for s in config.sides}
    against = [c for c in last_round.verdict.clashes if c.to_key == side.key]
    if not against:
        return ""
    lines = "\n".join(f"- {names.get(c.from_key, c.from_key)}：{c.point}" for c in against)
    return (
        "\n\n上一轮裁判记录你被这样反驳（请【优先正面回应】这些命门——能驳回就驳回、"
        f"该让步就坦诚让步，别回避）：\n{lines}"
    )


def _interjection_block(side: DebateSide, interjections: Sequence[UserInterjection]) -> str:
    """把用户【追问】拼进本辩手的 feedback —— 定向某方（``target_key``）的只喂给那一方，未定向
    （空 target）的喂给全场。追问是用户的最高优先级诉求，故明令【本轮优先正面回答】（先答追问、
    再展开），别答非所问。无（指向本方的）追问返回空串（feedback 不变、零行为变化）。"""
    mine = [i for i in interjections if i.ask and (not i.target_key or i.target_key == side.key)]
    if not mine:
        return ""
    directed = any(i.target_key == side.key for i in mine)
    who = "向你" if directed else "向全场"
    lines = "\n".join(f"- {i.ask}" for i in mine)
    return (
        f"\n\n⚠️ 用户在本轮追问（{who}提出，请【本轮优先正面回答】，先答这个、再展开你的论点，"
        f"别回避、别答非所问）：\n{lines}"
    )


def round_feedback(
    config: DebateConfig,
    side: DebateSide,
    round_no: int,
    focus: str,
    last_round: RoundResult,
    interjections: Sequence[UserInterjection] = (),
) -> str:
    """后续轮喂给 continue_run 的 feedback：本轮焦点 + 用户追问（如有）+ 对方上轮论点（裁剪）+
    上轮被驳命门 + 「只补新论点、勿重述」约束。

    辩手在【自己的 transcript】上续写（已带自己上轮全文），故无需也不应重述自己上轮——明令
    「只补本轮焦点下的新论点 / 新回应」根治冗余轮的「修订 v2 内容相似」（与 ``_frame`` 的焦点
    正交约束一上一下夹击：换维度提问 + 只答新东西）。对手发言【头尾裁剪】（:func:`_clip`）防多方
    圆桌 prompt 暴涨；并把上轮裁判指向本方的 clash 命门喂回，驱动精准接招（见 :func:`_challenged_block`）。
    ``interjections`` 是用户在上一轮边界注入、本轮须正面回应的【追问】（交互式逐轮，opt-in；定向
    本方或全场的才喂给本辩手）——置于焦点之后、最高优先级（见 :func:`_interjection_block`）。"""
    opponents = [t for t in last_round.ok_turns if t.side_key != side.key]
    if opponents:
        opp_block = "\n\n".join(f"### {t.side_name}\n{_clip(t.content)}" for t in opponents)
    else:
        opp_block = "（对方上一轮无有效发言）"
    challenged = _challenged_block(config, side, last_round)
    ask_block = _interjection_block(side, interjections)
    # 圆桌不强求对立：把「针对性回应」软化为「回应并补充」，贴合 role_directive 的圆桌语义。
    if config.form is DebateForm.ROUNDTABLE:
        engage = "请【回应并补充】（呼应有道理的、标出你视角下的分歧、贡献你这一视角独有的洞察）"
    else:
        engage = "请【针对性回应】（驳斥站不住的、承认确有道理的、推进你的立场）"
    return (
        f"## 第 {round_no} 轮 · 本轮焦点：{focus}\n"
        f"{role_directive(config, side)}{ask_block}\n\n"
        f"对方上一轮的论点如下，{engage}：\n"
        f"{opp_block}{challenged}\n\n"
        f"直接输出你本轮的【完整发言】：**只补本轮焦点下的新论点 / 新回应**，用具体证据 / 例子 / "
        f"推理链支撑（必要时用 web_search / read_url 取证）；不要重述你上一轮已说过的内容、"
        f"不要复述对方原话、不要罗列改动清单。{LENGTH_HINT}"
    )
