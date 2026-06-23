"""辩手 prompt 构造（首轮 task + 后续轮 feedback）。"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.debate import DebateConfig, DebateForm, DebateSide, RoundResult

from agentcore.tools.builtin.debate.schema import DEBATER_TOOLS, FORM_LABELS, LENGTH_HINT


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
        "论据具体、直面对方、不偷换概念、不因篇幅长而堆砌。"
    )
    return f"{base}{role_directive(config, side)}"


def debater_task(
    config: DebateConfig, side: DebateSide, idx: int, *, round_no: int, focus: str
) -> dict[str, Any]:
    """构造首轮单个辩手的 task dict（build_run_plan 入参）。"""
    task = (
        f"你在一场【{FORM_LABELS.get(config.form, '辩论')}】中代表「{side.name}」。\n"
        f"辩论命题：{config.motion}\n"
        f"你的立场 / 视角：{side.stance}\n"
        f"本轮议题：{focus}\n\n"
        f"{role_directive(config, side)}\n"
        f"请就本轮议题给出有力、具体、有论据的论证（这是你的开场立论）。{LENGTH_HINT}"
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
    # stance 仅正反 2 方有意义（builder 只认 pro/con，display-only）。
    if config.form is DebateForm.DEBATE and len(config.sides) == 2:
        payload["stance"] = "pro" if idx == 0 else "con"
    return payload


def round_feedback(
    config: DebateConfig,
    side: DebateSide,
    round_no: int,
    focus: str,
    last_round: RoundResult,
) -> str:
    """后续轮喂给 continue_run 的 feedback：本轮焦点 + 对方上轮论点 +
    「只补新论点、勿重述」约束。

    辩手在【自己的 transcript】上续写（已带自己上轮全文），故无需也不应重述自己上轮——明令
    「只补本轮焦点下的新论点 / 新回应」根治冗余轮的「修订 v2 内容相似」（与 ``_frame`` 的焦点
    正交约束一上一下夹击：换维度提问 + 只答新东西）。"""
    opponents = [t for t in last_round.ok_turns if t.side_key != side.key]
    if opponents:
        opp_block = "\n\n".join(f"### {t.side_name}\n{t.content}" for t in opponents)
    else:
        opp_block = "（对方上一轮无有效发言）"
    return (
        f"## 第 {round_no} 轮 · 本轮焦点：{focus}\n"
        f"{role_directive(config, side)}\n\n"
        f"对方上一轮的论点如下，请【针对性回应】（驳斥站不住的、承认确有道理的、推进你的立场）：\n"
        f"{opp_block}\n\n"
        f"直接输出你本轮的【完整发言】：**只补本轮焦点下的新论点 / 新回应**，不要重述你上一轮"
        f"已说过的内容、不要复述对方原话、不要罗列改动清单。{LENGTH_HINT}"
    )
