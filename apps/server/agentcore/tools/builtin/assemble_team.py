"""assemble_team: on-demand escalation from chat to a multi-agent team.

This is the single hinge of the "chat-first, orchestrate-on-demand" design
(参考行业实践: Claude Code 的 Agent/Task 工具、OpenAI Agents SDK 的 agents-as-tools).
The high-frequency chat agent owns the conversation and replies directly; only
when it judges a request truly needs a *team* (multi-perspective parallelism, a
design→implement→review pipeline, debate/compare) does it call this tool.

The tool is a per-turn instance carrying that turn's runtime wiring (llm / sink /
system prompt / history / worker tools), because the orchestrator + DAG need far
more context than the generic ``ToolContext`` provides. On invocation it asks the
orchestrator to plan a team, then runs the existing multi-agent DAG, whose
synthesizer streams the final answer straight to the user. It is therefore a
*handoff* tool (``terminal=True``): the answer is already streamed, so the chat
loop must stop rather than generate a second, duplicate reply.

Graceful degradation: if the orchestrator decides the task is actually single
agent (the chat model over-escalated), the tool returns a non-terminal result
telling the chat agent to just answer it directly — no team is spun up.
"""

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.runtime.events import EventSink
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)


class AssembleTeamTool:
    """Chat-agent tool that escalates a turn to a multi-agent team on demand."""

    def __init__(
        self,
        *,
        llm: DeepSeekProvider,
        sink: EventSink,
        system_prompt: str,
        user_message: str,
        history: list[dict],
        tools: ToolRegistry,
        base_tool_context: ToolContext,
    ) -> None:
        self._llm = llm
        self._sink = sink
        self._system_prompt = system_prompt
        self._user_message = user_message
        self._history = history
        self._tools = tools
        self._base_tool_context = base_tool_context

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="assemble_team",
            description=(
                "组建并启动一个多 Agent 团队来完成当前任务。"
                "仅当任务确实需要多个角色分工协作时才调用，例如："
                "需要多视角并行调研/对比、明显的多阶段流水线（如 设计→实现→测试）、"
                "需要辩论或交叉审阅的复杂任务。"
                "普通问答、闲聊、解释、单点搜索、单文件改写等简单请求不要调用——"
                "直接自己回答即可。调用后团队会自行规划、执行并把最终结果直接呈现给用户，"
                "你无需再重复作答。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": (
                            "交给团队的任务描述，应完整、自包含（团队看不到你和用户的"
                            "完整对话，只会收到这段任务）。留空则使用用户的原始消息。"
                        ),
                    },
                },
                "required": ["task"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        # Lazy imports: keep the tools package free of any import-time dependency
        # on the runtime package (which itself imports the tools registry).
        from agentcore.runtime.planner import make_plan
        from agentcore.runtime.runs import run_multi_agent

        task = (arguments.get("task") or "").strip() or self._user_message

        available_tools = [
            {
                "name": s.name,
                "description": s.description,
                "category": s.category.value,
            }
            for s in self._tools.list_all()
        ]

        plan = await make_plan(
            llm=self._llm,
            user_message=task,
            history=self._history,
            available_tools=available_tools,
        )

        # The chat model over-escalated: the orchestrator sees a single-agent
        # task. Degrade gracefully — let the chat agent answer it directly
        # instead of spinning up a (pointless) one-member "team".
        if not plan.is_multi_agent:
            logger.info("assemble_team_degraded_to_single", task_preview=task[:80])
            return ToolResult(
                tool_call_id="",
                success=True,
                output=(
                    "经编排器评估，该任务无需多 Agent 团队协作。"
                    "请你直接回答用户，不要再调用本工具。"
                ),
                terminal=False,
            )

        logger.info(
            "assemble_team_started",
            agents=len(plan.agents),
            steps=len(plan.steps),
        )
        result = await run_multi_agent(
            plan=plan,
            llm=self._llm,
            tools=self._tools,
            sink=self._sink,
            base_tool_context=self._base_tool_context,
            system_prompt=self._system_prompt,
            user_message=task,
        )

        return ToolResult(
            tool_call_id="",
            success=True,
            output="团队已完成协作，最终结果已直接呈现给用户。",
            terminal=True,
            terminal_content=result.get("content", ""),
            metadata={
                "input_tokens": result.get("input_tokens", 0),
                "output_tokens": result.get("output_tokens", 0),
                "reasoning_tokens": result.get("reasoning_tokens", 0),
            },
        )
