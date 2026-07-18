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

# Schema layer (工具面瘦身): short trigger + key param cues. HOW → debate_and_review skill.
DEBATE_DESCRIPTION = (
    "对需要【对抗性多视角思考】的问题发起主持人驱动的结构化辩论，交回【决策简报 + 交锋叙事线】"
    "双产物（非终结，产物回到你的循环）。"
    "form：debate=正反决策；red_team=红队压测方案（被审方标 is_subject）；roundtable=圆桌观点光谱。"
    "传 motion + form + sides（≥2）；轮数与收敛由主持人自调。"
    "各角度独立的并行调研用 delegate；无对立面 / 单点事实不要用本工具。"
    "细节见 consult_skill(debate_and_review)。"
)

DEBATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "motion": {
            "type": "string",
            "description": "辩论命题（用户原话或你提炼的争议命题）。",
        },
        "form": {
            "type": "string",
            "enum": ["debate", "red_team", "roundtable"],
            "description": "debate=正反攻防；red_team=红队挑刺被审方案；roundtable=多方圆桌。",
        },
        "sides": {
            "type": "array",
            "description": "参与方（≥2）：正反=2，圆桌≥3，红队=被审方 + ≥1 红队。",
            "items": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "机器标识（唯一英文短词，如 pro/con/red1）。",
                    },
                    "name": {
                        "type": "string",
                        "description": (
                            "展示名：简短的立场 / 视角名，各方对称同风格；勿塞模型名"
                            "（模型走 model 字段）。"
                        ),
                    },
                    "stance": {
                        "type": "string",
                        "description": (
                            "一句立场倾向（约 30 字内）：只说该方主张什么结论"
                            "（正例：「支持一审判决正确」/「认为判赔过重」）；"
                            "禁论点清单、论证角度指令、事实细节——"
                            "客观事实归 background，论点与论证路径归辩手自己检索构建。"
                            "反例（勿写）：「核心论点包括(1)…(4)；请从…角度系统论证」。"
                        ),
                    },
                    "is_subject": {
                        "type": "boolean",
                        "description": "仅红队形态：标记被审的方案方。",
                    },
                    "model": {
                        "type": "string",
                        "description": "（可选·MVP 未启用）per-side 模型覆写预留；请留空。",
                    },
                },
                "required": ["key", "name", "stance"],
            },
        },
        "thorough": {
            "type": "boolean",
            "description": (
                "默认 true=辩透（主持人自判收敛）；false=快速单轮对碰（用户只想轻量看看时）。"
            ),
        },
        "background": {
            "type": "string",
            "description": (
                "（可选）赛前底料：已核实客观事实清单，每条须附【来源】与【日期】；"
                "未决 / 推断不得写成既定事实；只放事实不放观点。纯价值观命题不必传。"
                "格式与硬化禁令见 debate_and_review。"
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
