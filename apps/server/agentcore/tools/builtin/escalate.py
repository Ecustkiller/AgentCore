"""escalate — a worker's upward channel: flag a decision/blocker for the CEO.

Worker-only. Wired into the delegated worker toolset (``build_worker_registry``) and
deliberately NOT in ``build_builtin_registry`` — so it never reaches the CEO's own
toolset (``build_ceo_tool_registry`` derives from the builtins) or the read-only
``GET /tools`` capability catalog. It is the WORKER's counterpart to the CEO's
``ask_user``: a delegated worker can't talk to the user (隔离边界), so when it hits a
fork only a human / 上级 can settle, it escalates to the CEO instead of either
silently guessing or burying a clarifying question in its prose.

非阻塞 by design (设计取向：不破坏隔离与成本). The call returns immediately
(``ToolEffect.CONTINUE``) and tells the worker to PROCEED on its best assumption — it
is NOT a stop. The escalation is harvested from the worker's transcript
(``runs.serialize.escalations_from_transcript``) into ``RunState.escalations`` and
surfaced PROMINENTLY in the CEO-facing aggregate (``DelegateTool._format_for_ceo``),
where the CEO resolves it with its OWN levers: ``ask_user`` (if the user must decide),
``revise`` (recall the author with the answer), or a fresh ``delegate``. The worker
keeps working so nothing hangs and the DAG isn't stalled; a wrong assumption is
corrected at synthesis, not propagated silently down the chain.

This is the industry-standard「escalation pattern」(notably Claude Code's recommended
subagent workflow: a subagent returns a structured clarification request to the main
agent, which then asks the user) rather than a subagent talking to the user directly —
no mainstream multi-agent product lets a parallel worker inject into the user's
conversation. 对比与决策见 docs/03-AI核心/Agent协作模式.md（向上澄清 / 升级通道）.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.runs.constants import ESCALATE_TOOL_NAME
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)


class EscalateTool:
    """The worker's「向上求决策」primitive: record a待决问题 for the CEO, keep working.

    Stateless: the call's structured args ride the worker's transcript, from which the
    executor harvests them into ``RunState.escalations``. ``execute`` only validates and
    returns a CONTINUE acknowledgement that steers the worker to deliver its best-effort
    result under its stated assumption (so an escalation never becomes an excuse to stop).
    """

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=ESCALATE_TOOL_NAME,
            description=(
                "把一个【必须由上级/用户拍板】的待决问题上报给主管（CEO）。你是被委派的 worker，"
                "够不到用户，这是你唯一的向上通道。仅在遇到【缺了就会让整件事走偏的关键信息】或"
                "【只有上级能定的关键岔路】时才用——能自行合理假设的小事不要升级。这【不会打断你、"
                "也不是停工】：上报后请立刻按你当下最合理的假设把任务继续做完、交付最佳结果；主管会"
                "看到你的升级并在你的产物之上纠偏（问用户 / 让你据答案重做 / 另行安排）。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": (
                            "必填。需要上级拍板的具体问题，写清楚、自包含——主管可能会把它"
                            "near-verbatim 转给用户，所以别依赖只有你才懂的局部上下文。"
                        ),
                    },
                    "assumption": {
                        "type": "string",
                        "description": (
                            "强烈建议：在拿到答复前你暂时采用的假设（你正据此继续交付）。"
                            "写明它，主管才能判断你的产物是否需要据真实答案返工。"
                        ),
                    },
                    "blocking": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。仅作给主管的【严重度标记】：true 表示这个岔路"
                            "猜错会让你的产物基本作废、强烈建议先解决。注意：即便 true 也不会"
                            "暂停你或流程——你仍要按假设把活做完。"
                        ),
                    },
                },
                "required": ["question"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(
        self, arguments: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        question = str(arguments.get("question") or "").strip()
        if not question:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="escalate 需要非空的 question（写清你要上级拍板的问题）。",
            )
        assumption = str(arguments.get("assumption") or "").strip()
        blocking = bool(arguments.get("blocking"))
        logger.info(
            "worker.escalate",
            run_id=context.run_id,
            blocking=blocking,
            has_assumption=bool(assumption),
        )
        note = (
            "已记录你的升级，主管会在汇总你的产物时处理。"
            "这不是停工：请立刻按你当前最合理的假设把任务继续做完、交付最佳结果"
        )
        note += (
            "（你已写明假设，主管能据此判断是否需要返工）。"
            if assumption
            else "，并尽量在产出里写明你采用了什么假设，方便主管纠偏。"
        )
        return ToolResult(tool_call_id="", success=True, output=note)
