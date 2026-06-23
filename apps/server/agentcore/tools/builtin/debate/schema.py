"""debate tool schema, constants, and argument parsing."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.debate import DebateForm, DebateSide
from agentcore.tools.protocol import ToolResult

DEBATE_OUTPUT_LIMIT = 16000

# 辩手最小权限工具集（least-privilege）：只给取证类工具（查资料 / 读网页），不给文件 / 代码 /
# 委派 / 提问等副作用工具——辩手职责是论证而非动手改东西，收窄可防跑偏、降多余开销。首轮经
# task 的 tools 字段成为 allow-list，后续轮经 session.spec 自动沿用。
DEBATER_TOOLS = ("web_search", "read_url")

# 辩手发言长度指引：旧观测里单方动辄数千 token（一条就几十秒），既拖慢又稀释论点。引导「宁深
# 勿长」——聚焦最有力的少数论点，显著降低每轮墙钟与 token。首轮立论与后续轮续写都注入。
LENGTH_HINT = (
    "聚焦你最有力的 2–3 个论点、约 400–600 字讲透，宁深勿长——不堆砌、不面面俱到。"
)

FORM_LABELS = {
    DebateForm.DEBATE: "正反辩论",
    DebateForm.RED_TEAM: "红队挑刺",
    DebateForm.ROUNDTABLE: "多方圆桌",
}

DEBATE_DESCRIPTION = (
    "对需要【对抗性多视角思考】的问题发起一场结构化辩论 / 交叉审查：由一个主持人逐轮派各方"
    "交锋、判收敛、自停，最后交回【决策简报 + 交锋叙事线】双产物。本工具非终结——产物回到你"
    "的循环，你据此为用户收尾（先给结论与建议，点出仅剩需用户拍板的点）。\n"
    "三形态：debate=正反辩论（选 A 还是 B / 该不该做 X）；red_team=红队挑刺（压力测试某个方案，"
    "把被审方案那一方标 is_subject）；roundtable=多方圆桌（学懂一个有争议话题的观点光谱）。\n"
    "你只需定【参与方与立场】：传 motion（命题）+ form（形态）+ sides（各方，≥2；圆桌建议 ≥3）。"
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
                        "description": "展示名（正方 / 红队 / 经济学视角）。",
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
                },
                "required": ["key", "name", "stance"],
            },
        },
        "thorough": {
            "type": "boolean",
            "description": (
                "是否认真辩透（默认 true，最小 3 轮）；false=快速单轮对碰。"
                "圆桌恒多轮（默认最小 2 轮）。"
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
        sides.append(
            DebateSide(key=key, name=name, stance=stance, is_subject=bool(item.get("is_subject")))
        )
    if len(sides) < 2:
        return [], "debate 至少需要 2 个有效参与方（每个含非空 key/name/stance）。"
    return sides, ""
