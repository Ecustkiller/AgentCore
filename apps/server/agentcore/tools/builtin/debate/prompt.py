"""辩手 prompt 构造（首轮 task + 后续轮 feedback）。"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.debate import DebateConfig, DebateForm, DebateSide, RoundResult

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


def debater_task(
    config: DebateConfig, side: DebateSide, idx: int, *, round_no: int, focus: str
) -> dict[str, Any]:
    """构造首轮单个辩手的 task dict（build_run_plan 入参）。"""
    # 快速对碰：注入轻量约束压住「为小题深挖」（少检索、收窄论点）；认真辩透则不加。
    quick_suffix = "" if config.policy.thorough else f"\n{QUICK_DEBATER_HINT}"
    task = (
        f"你在一场【{FORM_LABELS.get(config.form, '辩论')}】中代表「{side.name}」。\n"
        f"辩论命题：{config.motion}\n"
        f"你的立场 / 视角：{side.stance}\n"
        f"本轮议题：{focus}\n\n"
        f"{role_directive(config, side)}\n"
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


def round_feedback(
    config: DebateConfig,
    side: DebateSide,
    round_no: int,
    focus: str,
    last_round: RoundResult,
) -> str:
    """后续轮喂给 continue_run 的 feedback：本轮焦点 + 对方上轮论点（裁剪）+ 上轮被驳命门 +
    「只补新论点、勿重述」约束。

    辩手在【自己的 transcript】上续写（已带自己上轮全文），故无需也不应重述自己上轮——明令
    「只补本轮焦点下的新论点 / 新回应」根治冗余轮的「修订 v2 内容相似」（与 ``_frame`` 的焦点
    正交约束一上一下夹击：换维度提问 + 只答新东西）。对手发言【头尾裁剪】（:func:`_clip`）防多方
    圆桌 prompt 暴涨；并把上轮裁判指向本方的 clash 命门喂回，驱动精准接招（见 :func:`_challenged_block`）。"""
    opponents = [t for t in last_round.ok_turns if t.side_key != side.key]
    if opponents:
        opp_block = "\n\n".join(f"### {t.side_name}\n{_clip(t.content)}" for t in opponents)
    else:
        opp_block = "（对方上一轮无有效发言）"
    challenged = _challenged_block(config, side, last_round)
    # 圆桌不强求对立：把「针对性回应」软化为「回应并补充」，贴合 role_directive 的圆桌语义。
    if config.form is DebateForm.ROUNDTABLE:
        engage = "请【回应并补充】（呼应有道理的、标出你视角下的分歧、贡献你这一视角独有的洞察）"
    else:
        engage = "请【针对性回应】（驳斥站不住的、承认确有道理的、推进你的立场）"
    return (
        f"## 第 {round_no} 轮 · 本轮焦点：{focus}\n"
        f"{role_directive(config, side)}\n\n"
        f"对方上一轮的论点如下，{engage}：\n"
        f"{opp_block}{challenged}\n\n"
        f"直接输出你本轮的【完整发言】：**只补本轮焦点下的新论点 / 新回应**，用具体证据 / 例子 / "
        f"推理链支撑（必要时用 web_search / read_url 取证）；不要重述你上一轮已说过的内容、"
        f"不要复述对方原话、不要罗列改动清单。{LENGTH_HINT}"
    )
