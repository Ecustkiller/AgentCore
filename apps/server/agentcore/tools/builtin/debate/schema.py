"""debate tool schema + argument parsing（薄适配层；域常量见 runtime.debate.constants）。"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.debate import DebateForm, DebateSide
from agentcore.runtime.debate.constants import (
    CLOSING_LENGTH_HINT,
    CX_LENGTH_HINT,
    DEBATE_OUTPUT_LIMIT,
    DEBATER_TOOLS,
    FORM_LABELS,
    LENGTH_HINT,
    QUICK_DEBATER_HINT,
)
from agentcore.tools.protocol import ToolResult

__all__ = [
    "DEBATE_OUTPUT_LIMIT",
    "DEBATER_TOOLS",
    "LENGTH_HINT",
    "CLOSING_LENGTH_HINT",
    "CX_LENGTH_HINT",
    "QUICK_DEBATER_HINT",
    "FORM_LABELS",
    "DEBATE_DESCRIPTION",
    "DEBATE_PARAMETERS",
    "err",
    "parse_form",
    "parse_background",
    "parse_sides",
]

DEBATE_DESCRIPTION = (
    "对需要【对抗性多视角思考】的问题发起一场结构化辩论 / 交叉审查：由一个主持人逐轮派各方"
    "交锋、判收敛、自停，最后交回【决策简报 + 交锋叙事线】双产物。本工具非终结——产物回到你"
    "的循环，你据此为用户收尾（先给结论与建议，点出仅剩需用户拍板的点）。\n"
    "三形态：debate=正反辩论（选 A 还是 B / 该不该做 X）；red_team=红队挑刺（压力测试某个方案，"
    "把被审方案那一方标 is_subject）；roundtable=多方圆桌（学懂一个有争议话题的观点光谱）。\n"
    "你只需定【参与方与立场】：传 motion（命题）+ form（形态）+ sides（各方，≥2；圆桌建议 ≥3）；"
    "具体案件 / 真实事件类命题建议另传 background（已核实客观事实清单：每条须附来源与日期，"
    "未决/推断状态不得写成既定事实，见参数说明），避免各方重复检索底料。"
    "轮数与收敛由主持人自调，你和用户都不设轮数。简单事实问答 / 无对立面的任务不要用本工具。"
)

DEBATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "motion": {
            "type": "string",
            "description": "辩论命题 / 要解决的问题（用户的原始问题，或你提炼出的争议命题）。",
        },
        "form": {
            "type": "string",
            "enum": ["debate", "red_team", "roundtable"],
            "description": (
                "形态：debate=正反对称攻防；red_team=红队单向挑刺被审方案；roundtable=多方"
                "视角圆桌。据问题性质选：做决策→debate；压力测试方案→red_team；探讨争议→roundtable。"
            ),
        },
        "sides": {
            "type": "array",
            "description": "参与方（≥2）：正反=2，圆桌≥3，红队=被审方案方 + ≥1 个红队。",
            "items": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": (
                            "机器标识（如 pro/con/red1，唯一英文短词，用于跨轮定位）。"
                        ),
                    },
                    "name": {
                        "type": "string",
                        "description": (
                            "展示名：用简短的【立场 / 视角】名，且各方【对称、同一风格】"
                            "（甜党 / 咸党、正方 / 反方、经济学视角 / 工程视角）。"
                            "不要一方用立场名、另一方却用模型名（如「原生DeepSeek」）——"
                            "模型是下方单独的 model 字段（界面另有徽章标注），"
                            "别把模型名塞进展示名。例外：辩论本身就是「比谁更聪明」、"
                            "各方即以模型为身份时，两方都统一用模型名。"
                        ),
                    },
                    "stance": {
                        "type": "string",
                        "description": "该方的立场 / 视角定位（喂给辩手，让它据此论证）。",
                    },
                    "is_subject": {
                        "type": "boolean",
                        "description": (
                            "仅红队形态：标记被审的【方案方】（承受单向攻击并回应修补）。"
                        ),
                    },
                    "model": {
                        "type": "string",
                        "description": (
                            "（可选·MVP 未启用）Phase 3 真·多模型辩手的 per-side 覆写预留字段。"
                            "当前 MVP 全链路统一用户 model，此值解析入库但【不注入辩手执行】——"
                            "设了也不会让各方跑不同模型。普通辩论请留空；勿为「谁更聪明」对战而填。"
                        ),
                    },
                },
                "required": ["key", "name", "stance"],
            },
        },
        "thorough": {
            "type": "boolean",
            "description": (
                "是否认真辩透（默认 true）：true=主持人逐轮自判收敛、挖尽实质分歧"
                "（安全上限 5 轮、圆桌 4 轮，收敛永远可早于上限发生）；false=快速单轮"
                "对碰、一次交锋即收。轮数与收敛全由主持人自调，你和用户都不设轮数。"
            ),
        },
        "background": {
            "type": "string",
            "description": (
                "（可选）赛前底料：具体案件 / 真实事件 / 有客观事实基础的命题，开辩前先检索"
                " 3–5 条【已核实客观事实】传入。每条须同时具备：(1) 客观事实陈述；"
                "(2)【来源】（文书文号 / 官网 URL / 权威报道标题等）；(3)【日期】（事实发生或文书日期）。"
                "格式示例：「2024-06-12 · 一审判决驳回诉讼请求【来源：某中院（2023）×民终××号判决书】」。"
                "【硬化禁令】未决 / 推断 / 当事人单方陈述不得写成既定事实——"
                "如仅有「被告表示将上诉」不得写成「案件处于二审阶段」；程序节点以已发生文书/公告为准。"
                "只放客观事实，不放观点 / 评价 / 立场分析。首轮由主持人以「双方共享底料」名义喂全部辩手。"
                "纯价值观或开放式命题不必传；不传则辩手自行取证。"
            ),
        },
    },
    "required": ["motion", "form", "sides"],
}


def err(msg: str) -> ToolResult:
    return ToolResult(tool_call_id="", success=False, output=msg, error=msg)


def parse_form(raw: Any) -> DebateForm:
    if isinstance(raw, str):
        try:
            return DebateForm(raw.strip())
        except ValueError:
            pass
    return DebateForm.DEBATE


def parse_background(raw: Any) -> str:
    """解析可选案件底料；仅收非空字符串，其它类型 / 缺省 → 空串（零行为变化路径）。"""
    if not isinstance(raw, str):
        return ""
    return raw.strip()


def parse_sides(raw: Any) -> tuple[list[DebateSide], str]:
    """把 sides 原始数组解析为 :class:`DebateSide` 列表；返回 (sides, 错误信息)。"""
    if not isinstance(raw, list) or len(raw) < 2:
        return [], "debate 需要 sides（参与方数组，至少 2 个，每个含 key/name/stance）。"
    sides: list[DebateSide] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        name = str(item.get("name") or "").strip()
        stance = str(item.get("stance") or "").strip()
        if not key or not name or not stance:
            continue
        if key in seen:
            return [], f"sides 的 key 重复：`{key}`（每个参与方需唯一 key）。"
        seen.add(key)
        # model（可选）：Phase 3 真·多模型辩手预留，宽松解析（仅收非空字符串）；MVP 不注入执行。
        model = str(item.get("model") or "").strip()
        sides.append(
            DebateSide(
                key=key,
                name=name,
                stance=stance,
                is_subject=bool(item.get("is_subject")),
                model=model,
            )
        )
    if len(sides) < 2:
        return [], "debate 至少需要 2 个有效参与方（每个含非空 key/name/stance）。"
    return sides, ""
