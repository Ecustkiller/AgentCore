"""Orchestrator checkpoint review.

At a checkpoint the orchestrator (fast model) inspects the just-finished step's
output and decides how to proceed — without bothering the user unless it must:

- ``continue``: output is sound, follow the plan as-is.
- ``adjust``: broadly right but needs a correction the orchestrator can state
  itself; the adjustment is injected into downstream steps (no user prompt).
- ``escalate``: genuine ambiguity / risk / low confidence — hand the decision to
  the user (becomes an ``approval_required``).

This realises the design's "编排器是唯一裁决者，用户裁决仅在置信度低时触发"
(Agent协作模式.md §三). Any malformed/failed review falls open to ``continue`` so a
flaky model degrades the gate to a no-op rather than blocking execution.
"""

import json
from dataclasses import dataclass
from typing import Literal

from agentcore.core.logging import get_logger
from agentcore.llm.config import build_request, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage

logger = get_logger(__name__)

Decision = Literal["continue", "adjust", "escalate"]
_VALID_DECISIONS: set[str] = {"continue", "adjust", "escalate"}
_OUTPUT_MAX_CHARS = 2000

_REVIEW_SYSTEM_PROMPT = """\
你是 AgentCore 的任务编排器，正在一个检查点审视某个步骤的产出，决定后续如何推进。

只输出一个 JSON 对象，不要任何额外文字或 markdown 代码块：
{
  "decision": "continue | adjust | escalate",
  "reason": "你的判断理由（简短，展示给用户）",
  "adjustment": "decision=adjust 时给下游步骤的补充指令；否则为空字符串"
}

判定标准：
- continue：产出合理、方向正确，按原计划继续。
- adjust：方向基本正确但需要纠偏/补充，且你能明确给出调整指令让后续步骤据此修正（不打断用户）。
- escalate：存在你无法独立判断的分歧、风险或歧义，置信度低，需要用户拍板。
- 默认偏向 continue；确有必要纠偏才 adjust；真正拿不准才 escalate。
- escalate 会打断用户，务必克制。"""


@dataclass
class CheckpointDecision:
    decision: Decision
    reason: str = ""
    feedback: str = ""


def _build_user_content(
    *,
    task_summary: str,
    step_role: str,
    step_task: str,
    output: str,
    review_focus: str,
) -> str:
    trimmed = output.strip()
    if len(trimmed) > _OUTPUT_MAX_CHARS:
        trimmed = trimmed[:_OUTPUT_MAX_CHARS] + "…"
    return (
        f"## 总任务\n{task_summary}\n\n"
        f"## 刚完成的步骤\n角色：{step_role}\n任务：{step_task}\n\n"
        f"## 该步骤产出\n{trimmed or '（空）'}\n\n"
        f"## 本检查点关注\n{review_focus or '（无特别说明）'}\n\n"
        "现在输出审视结论 JSON。"
    )


def _parse_decision(raw: str) -> CheckpointDecision:
    text = raw.strip()
    if "```" in text:
        start = text.find("```")
        fence = text[start + 3 :]
        if fence.lower().startswith("json"):
            fence = fence[4:]
        end = fence.rfind("```")
        if end != -1:
            fence = fence[:end]
        text = fence.strip()
    first = text.find("{")
    last = text.rfind("}")
    if first == -1 or last == -1 or last < first:
        raise ValueError("no JSON object found")
    data = json.loads(text[first : last + 1])

    decision = str(data.get("decision") or "").strip().lower()
    if decision not in _VALID_DECISIONS:
        raise ValueError(f"invalid decision: {decision!r}")
    return CheckpointDecision(
        decision=decision,  # type: ignore[arg-type]
        reason=str(data.get("reason") or "").strip(),
        feedback=str(data.get("adjustment") or "").strip(),
    )


async def review_checkpoint(
    *,
    llm: DeepSeekProvider,
    task_summary: str,
    step_role: str,
    step_task: str,
    output: str,
    review_focus: str,
    fallback_reason: str = "",
) -> CheckpointDecision:
    """Ask the orchestrator to judge a checkpoint; fail open to ``continue``."""
    try:
        response = await llm.complete(
            build_request(
                get_profile("orchestrator"),
                [
                    LLMMessage(role="system", content=_REVIEW_SYSTEM_PROMPT),
                    LLMMessage(
                        role="user",
                        content=_build_user_content(
                            task_summary=task_summary,
                            step_role=step_role,
                            step_task=step_task,
                            output=output,
                            review_focus=review_focus,
                        ),
                    ),
                ],
                tool_choice="none",
                stream=False,
            )
        )
        decision = _parse_decision(response.content)
        logger.info(
            "checkpoint_reviewed",
            decision=decision.decision,
            has_feedback=bool(decision.feedback),
        )
        # An adjust with no concrete instruction can't steer anything — treat as
        # continue so we don't claim a correction we never made.
        if decision.decision == "adjust" and not decision.feedback:
            return CheckpointDecision("continue", reason=decision.reason)
        return decision
    except Exception as e:  # noqa: BLE001 — review is advisory; never block on it
        logger.warning("checkpoint_review_failed", error=str(e))
        return CheckpointDecision("continue", reason=fallback_reason)
