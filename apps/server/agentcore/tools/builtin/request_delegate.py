"""request_delegate — a worker's on-demand application for nested delegation rights.

Worker-only. Offered when ``can_delegate="auto"`` (Phase 3): the worker starts as a
leaf and may call this tool mid-run when parallel sub-team split is clearly worth it.
On approval it gains ``delegate`` + ``replan`` (via :class:`LeadSubteam`) and loses
this tool. Identity / system prompt are NOT switched — management guidance rides the
tool result instead.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.runs.constants import MAX_DELEGATION_DEPTH, REQUEST_DELEGATE_TOOL_NAME
from agentcore.runtime.runs.executor_identities import DelegateFactory, LeadSubteam
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

_ROUND_BUDGET_SOFT_LIMIT = 0.7

_APPROVED_GUIDANCE = """\
已批准。你现在可以使用 delegate 工具把任务拆给子团队。注意事项：
- 只在拆分收益明显大于串行时才拆，别为拆而拆
- 你的子成员不能继续委派
- 拆分后你负责整合子团队产出，用 handoff 交接最终成果
- 如果子计划让出了边界（输出「计划已让出」），用 replan 续跑"""


@dataclass
class WorkerDelegationState:
    """Mutable per-worker handles ``request_delegate`` mutates mid-run."""

    registry: ToolRegistry
    allowed_tools: list[str] | None
    current_round: list[int]
    lead_subteam: LeadSubteam | None = None


class RequestDelegateTool:
    """Worker applies for nested delegation when ``can_delegate="auto"``."""

    def __init__(
        self,
        *,
        depth: int,
        max_rounds: int,
        delegate_factory: DelegateFactory,
        state: WorkerDelegationState,
    ) -> None:
        self._depth = depth
        self._max_rounds = max_rounds
        self._delegate_factory = delegate_factory
        self._state = state

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=REQUEST_DELEGATE_TOOL_NAME,
            description=(
                "申请派人权：当你发现当前任务可以拆分给子团队并行完成、且拆分收益明显大于"
                "串行时调用。批准后你将获得 delegate 工具。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "为什么需要拆分（简述拆分理由和预期的并行结构）",
                    },
                    "expected_subtasks": {
                        "type": "integer",
                        "description": "预期拆成几个子任务",
                    },
                },
                "required": ["reason"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        if self._state.lead_subteam is not None:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="你已拥有 delegate 权限，无需重复申请。",
            )

        reason = str(arguments.get("reason") or "").strip()
        if not reason:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="request_delegate 需要非空的 reason（简述为什么需要拆分）。",
            )

        if self._depth >= MAX_DELEGATION_DEPTH:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=(
                    f"已达委派深度上限（depth={self._depth}，上限 {MAX_DELEGATION_DEPTH}），"
                    "不能再向下委派。请继续串行完成当前任务。"
                ),
            )

        current = self._state.current_round[0] if self._state.current_round else 0
        if self._max_rounds > 0 and current / self._max_rounds > _ROUND_BUDGET_SOFT_LIMIT:
            return ToolResult(
                tool_call_id="",
                success=False,
                output=(
                    f"已跑 {current}/{self._max_rounds} 轮（超过预算 70%），"
                    "建议继续串行完成剩余工作，不要再拆分。"
                ),
                error="轮数预算不足，拒绝申请派人权。",
            )

        expected = arguments.get("expected_subtasks")
        logger.info(
            "worker.request_delegate",
            run_id=context.run_id,
            depth=self._depth,
            current_round=current,
            max_rounds=self._max_rounds,
            expected_subtasks=expected,
            reason=reason[:200],
        )

        lead = self._delegate_factory(context.run_id, self._depth)
        for tool in lead.tools:
            self._state.registry.register(tool)
        self._state.registry.unregister(REQUEST_DELEGATE_TOOL_NAME)

        if self._state.allowed_tools is not None:
            names = [n for n in self._state.allowed_tools if n != REQUEST_DELEGATE_TOOL_NAME]
            for name in lead.tool_names:
                if name not in names:
                    names.append(name)
            self._state.allowed_tools[:] = names

        self._state.lead_subteam = lead
        return ToolResult(tool_call_id="", success=True, output=_APPROVED_GUIDANCE)
