"""DebateTool — CEO 发起结构化辩论 / 交叉审查的编排原语。"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, new_id
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.runtime.debate import (
    DebateConfig,
    Moderator,
    RoundPolicy,
    RoundResult,
)
from agentcore.runtime.events import (
    EventSink,
    debate_result,
    debate_round,
    debate_round_started,
    run_started,
)
from agentcore.tools.builtin.debate.events import account_moderator, moderator_plan_event
from agentcore.tools.builtin.debate.rounds import make_round_runner
from agentcore.tools.builtin.debate.schema import (
    DEBATE_DESCRIPTION,
    DEBATE_OUTPUT_LIMIT,
    DEBATE_PARAMETERS,
    err,
    parse_form,
    parse_sides,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.runs.session import RunSession

logger = get_logger(__name__)


class DebateTool:
    """CEO-agent tool：发起主持人驱动的结构化辩论，返回双产物供 CEO 收尾（非终结）。

    持有与 ``DelegateTool`` 同形的「用量 + 账目 + 引用」累加器（``_acc``），辩手 run（首轮
    executor、后续轮 continue_run）与主持人自身 LLM 调用都折算进去，由 pipeline 折回回合总账。
    ``_debater_sessions`` 按 side.key 留住每个辩手的可续写 session，支撑跨轮带记忆。
    """

    def __init__(
        self,
        *,
        llm: DeepSeekProvider,
        sink: EventSink,
        system_prompt: str,
        user_message: str,
        tools: ToolRegistry,
        base_tool_context: ToolContext,
        profile_set: ProfileSet | None = None,
        max_parallel: int | None = None,
        captain_run_id: str | None = None,
        approval_gate: ApprovalGate | None = None,
        depth: int = 0,
    ) -> None:
        self._llm = llm
        self._sink = sink
        self._system_prompt = system_prompt
        self._user_message = user_message
        self._tools = tools
        self._base_tool_context = base_tool_context
        self._profile_set = profile_set or default_profile_set()
        self._max_parallel = max_parallel
        self._captain_run_id = captain_run_id
        self._approval_gate = approval_gate
        self._depth = depth
        # 每个 side 的可续写 session（跨轮带记忆）：首轮执行后留人，后续轮 continue_run 取用。
        self._debater_sessions: dict[str, RunSession] = {}
        from agentcore.runtime.costing import WorkerResultAccumulator

        self._acc = WorkerResultAccumulator()

    @property
    def usage(self) -> dict[str, int]:
        """本回合辩论累计 token 用量（辩手 + 主持人；pipeline 折回回合总账）。"""
        return self._acc.usage

    @property
    def run_ledger(self) -> list[RunCost]:
        """每个计费 run 一行账目（辩手各一行 + 主持人一行，决策②）。"""
        return self._acc.run_ledger

    @property
    def citations(self) -> list[dict[str, Any]]:
        """辩手查阅的网页来源（去重，折入回合共享来源卡）。"""
        return self._acc.citations

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="debate",
            description=DEBATE_DESCRIPTION,
            parameters=DEBATE_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        from agentcore.runtime.costing import usage_metadata

        motion = str(arguments.get("motion") or "").strip()
        if not motion:
            return err("debate 需要 motion（辩论命题 / 要解决的问题）。")
        sides, side_err = parse_sides(arguments.get("sides"))
        if side_err:
            return err(side_err)
        form = parse_form(arguments.get("form"))
        thorough = arguments.get("thorough", True)
        if not isinstance(thorough, bool):
            thorough = True
        policy = RoundPolicy.for_form(form, thorough=thorough)
        config = DebateConfig(motion=motion, form=form, sides=sides, policy=policy)

        execution_id = self._base_tool_context.execution_id or new_id()
        moderator_run_id = f"debate_{new_id()}"
        moderator_model = self._profile_set.agent(config.model_preference).model

        # 先声明主持人节点（CEO 之下、辩手之上的编排角色），辩手节点逐轮声明。
        self._sink.emit(moderator_plan_event(self, execution_id, moderator_run_id, config))
        # 主持人作为完成态节点：开播 run_started（parent=CEO 主气泡 run），收场 run_completed
        # （见 account_moderator）——团队进度因此把主持人计入并正确收尾，不再永久 pending。
        self._sink.emit(
            run_started(
                moderator_run_id,
                moderator_run_id,
                parent_run_id=self._captain_run_id,
            )
        )
        logger.info("debate.started", form=form.value, sides=len(sides), motion=motion[:80])

        moderator = Moderator(provider=self._llm, model=moderator_model)
        runner = make_round_runner(self, execution_id, moderator_run_id, config)

        # 逐轮增量 SSE（进行中实时叠加，transport-only）：开场先报焦点，收尾再报本轮裁判 + 小结。
        async def _emit_round_start(round_no: int, focus: str) -> None:
            self._sink.emit(
                debate_round_started(
                    execution_id=execution_id,
                    moderator_run_id=moderator_run_id,
                    round_no=round_no,
                    focus=focus,
                )
            )

        async def _emit_round(rr: RoundResult) -> None:
            self._sink.emit(
                debate_round(
                    execution_id=execution_id,
                    moderator_run_id=moderator_run_id,
                    payload=rr.to_event_payload(),
                )
            )

        started_at = time.monotonic()
        try:
            result = await moderator.run(
                config,
                run_round=runner,
                on_round_start=_emit_round_start,
                on_round=_emit_round,
            )
        except Exception as exc:  # noqa: BLE001 — 辩论崩溃降级为工具失败，让 CEO 回落
            logger.exception("debate.failed", motion=motion[:80])
            return err(f"辩论执行失败：{exc}。可重试，或改用 delegate 单独处理。")

        duration_ms = int((time.monotonic() - started_at) * 1000)
        account_moderator(self, moderator, moderator_run_id, moderator_model, result, duration_ms)
        # 收场广播完整辩论结构（简报 + 叙事线），前端据此渲染辩论视图；进 journal 可重载回放。
        self._sink.emit(
            debate_result(
                execution_id=execution_id,
                moderator_run_id=moderator_run_id,
                payload=result.to_event_payload(),
            )
        )
        logger.info("debate.done", rounds=len(result.rounds), stop=result.stop_reason)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=result.to_ceo_output(),
            output_limit=DEBATE_OUTPUT_LIMIT,
            metadata=usage_metadata(self._acc.usage),
        )
