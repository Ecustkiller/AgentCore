"""DebateTool — CEO 发起结构化辩论 / 交叉审查的编排原语。"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import AutonomyPolicy, ToolApproval, ToolCategory, ToolEffect, new_id
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import default_turn_profiles as default_profile_set
from agentcore.llm.provider.protocol import LLMProvider
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.debate import (
    DebateConfig,
    Moderator,
    RoundBoundary,
    RoundPolicy,
    RoundResult,
)
from agentcore.runtime.debate.events import account_moderator, moderator_plan_event
from agentcore.runtime.debate.rounds import (
    make_closing_runner,
    make_cross_exam_runner,
    make_round_runner,
)
from agentcore.runtime.debate.steer_queue import fold_steers, take_steers
from agentcore.runtime.events import (
    EventSink,
    debate_result,
    debate_round,
    debate_round_started,
    run_started,
)
from agentcore.runtime.plan_only import PlanOnlyAbortError
from agentcore.tools.builtin.debate.schema import (
    DEBATE_DESCRIPTION,
    DEBATE_OUTPUT_LIMIT,
    DEBATE_PARAMETERS,
    err,
    parse_background,
    parse_form,
    parse_sides,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.ports import ClientRequestBridge
    from agentcore.runtime.runs.session import RunSession
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

logger = get_logger(__name__)


class DebateTool:
    """CEO-agent tool：发起主持人驱动的结构化辩论，返回双产物供 CEO 收尾（非终结）。

    持有与 ``DelegateTool`` 同形的「用量 + 账目 + 引用」累加器（``_acc``），辩手 run（首轮
    executor、后续轮 continue_run）与主持人自身 LLM 调用都折算进去，由 pipeline 折回回合总账。
    ``_debater_sessions`` 按 side.key 留住每个辩手的可续写 session，支撑跨轮带记忆。

    顶层调用在主持人循环启动前走编排层开工卡（``team_preview``，primitive=debate）；
    嵌套 / 续跑 / full_auto 跳过语义对齐 delegate。
    """

    def __init__(
        self,
        *,
        llm: LLMProvider,
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
        conversation_id: str = "",
        ambient_armed: bool = False,
        message_id: str | None = None,
        suspension_saver: SuspensionSaver | None = None,
        suspension_deleter: SuspensionDeleter | None = None,
        folder_id: str | None = None,
        memory_enabled: bool = True,
        autonomy_policy: AutonomyPolicy | None = None,
        registry: ClientRequestBridge | None = None,
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
        # ambient 掌舵闸：有活跃用户即武装（同 ask_user 的 checkpoint 闸）——无活跃用户
        # （自治 / handoff）不挂 on_round_boundary，辩论纯裁判自判；有用户则轮次边界非阻塞
        # drain steer 队列（永不硬停）。
        self._conversation_id = conversation_id
        self._ambient_armed = ambient_armed
        self._message_id = message_id
        self._suspension_saver = suspension_saver
        self._suspension_deleter = suspension_deleter
        self._folder_id = folder_id
        self._memory_enabled = memory_enabled
        self._autonomy_policy = autonomy_policy or AutonomyPolicy.FIRST_GRANT
        self._registry = registry
        self._pending_pause = False
        # 每个 side 的可续写 session（跨轮带记忆）：首轮执行后留人，后续轮 continue_run 取用。
        self._debater_sessions: dict[str, RunSession] = {}
        from agentcore.runtime.costing import WorkerResultAccumulator

        self._acc = WorkerResultAccumulator()

    def _kickoff_system_prompt(self) -> str:
        return self._system_prompt

    def _kickoff_tool_name(self) -> str:
        return "debate"

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

    async def execute(
        self,
        arguments: dict[str, Any],
        context: ToolContext,
        *,
        skip_kickoff: bool = False,
    ) -> ToolResult:
        from agentcore.runtime.costing import usage_metadata

        self._pending_pause = False
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
        # `_kickoff_ask` 为 resume 注入的内部键（非 schema / 非 wire），开赛嘱咐进首轮插话管道。
        kickoff_ask = str(arguments.get("_kickoff_ask") or "").strip()
        config = DebateConfig(
            motion=motion,
            form=form,
            sides=sides,
            policy=policy,
            background=parse_background(arguments.get("background")),
            kickoff_ask=kickoff_ask,
        )

        if not skip_kickoff:
            early = await self._kickoff_before_moderator(config, arguments)
            if early is not None:
                return early

        return await self._run_moderator(config, usage_metadata)

    async def resume_after_kickoff(
        self,
        *,
        decision: CheckpointDecision,
        note: str,
        arguments: dict[str, Any],
    ) -> ToolResult:
        """Settle a debate kickoff: STOP → cancel; CONTINUE/ADJUST → run moderator.

        CONTINUE/ADJUST + note → 开赛嘱咐（首轮全场插话），不覆写 motion / 不改 sides。
        ADJUST 枚举保留供历史挂起帧 / API；语义与 CONTINUE+note 同构。
        """

        if decision is CheckpointDecision.STOP:
            closing = (note or "").strip() or "用户停止了辩论，未开赛。"
            return ToolResult(
                tool_call_id="",
                success=True,
                output=closing,
                effect=ToolEffect.CONTINUE,
            )

        args = dict(arguments)
        note_text = (note or "").strip()
        if note_text and decision in (
            CheckpointDecision.CONTINUE,
            CheckpointDecision.ADJUST,
        ):
            args["_kickoff_ask"] = note_text

        return await self.execute(args, self._base_tool_context, skip_kickoff=True)

    async def _kickoff_before_moderator(
        self,
        config: DebateConfig,
        arguments: dict[str, Any],
    ) -> ToolResult | None:
        """Durable kickoff before ``debate.started``. Nested / full_auto skip."""
        if self._depth != 0:
            return None
        from agentcore.runtime.kickoff import (
            await_kickoff,
            debate_kickoff_summary,
            needs_capability_auth,
            should_kickoff,
            skip_after_confirmed_ask,
        )
        from agentcore.runtime.sandbox_approval import worker_gate_applies

        autonomy = self._autonomy_policy
        local_gate = worker_gate_applies(self._base_tool_context.backend)
        # Debate always wants the plan half at top-level; capability half is False
        # for read-only debaters (local_gate tools aren't grantable for debate).
        if not should_kickoff(
            plan_preview=True,
            local_gate=local_gate,
            autonomy=autonomy,
        ):
            return None
        if (
            skip_after_confirmed_ask(self)
            and not needs_capability_auth(local_gate=local_gate, autonomy=autonomy)
        ):
            return None

        # Capability half stays False for debate (read-only debaters) — never list tools.
        summary = debate_kickoff_summary(config, arguments=arguments, tools=[])
        decision = await await_kickoff(self, summary, plan=None)
        if self._pending_pause:
            logger.info(
                "debate.team_preview_paused",
                sides=len(config.sides),
                motion=config.motion[:80],
            )
            return ToolResult(
                tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND
            )
        if decision is CheckpointDecision.STOP:
            return ToolResult(
                tool_call_id="",
                success=True,
                output="用户停止了辩论，未开赛。",
                effect=ToolEffect.CONTINUE,
            )
        return None

    async def _run_moderator(self, config: DebateConfig, usage_metadata) -> ToolResult:
        execution_id = self._base_tool_context.execution_id or new_id()
        moderator_run_id = f"debate_{new_id()}"
        moderator_model = self._profile_set.model_for(
            f"agent.{config.model_preference.value if hasattr(config.model_preference, 'value') else config.model_preference}"
        )

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
        logger.info(
            "debate.started",
            form=config.form.value,
            sides=len(config.sides),
            motion=config.motion[:80],
        )

        moderator = Moderator(
            provider=self._llm,
            model=moderator_model,
            run_id=moderator_run_id,
            parent_run_id=self._captain_run_id,
        )
        runner = make_round_runner(self, execution_id, moderator_run_id, config)
        cross_exam_runner = make_cross_exam_runner(self, execution_id, moderator_run_id, config)
        closing_runner = make_closing_runner(self, execution_id, moderator_run_id, config)

        from agentcore.runtime.debate.moderator_agenda import cross_exam_enabled

        cx_enabled = cross_exam_enabled(config)

        async def _emit_round_start(round_no: int, focus: str, opening: str) -> None:
            self._sink.emit(
                debate_round_started(
                    execution_id=execution_id,
                    moderator_run_id=moderator_run_id,
                    round_no=round_no,
                    focus=focus,
                    cross_exam_enabled=cx_enabled,
                    opening=opening,
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

        async def _round_boundary(
            *, round_no: int, result: RoundResult, converged: bool, max_rounds: int
        ) -> RoundBoundary | None:
            steers = take_steers(execution_id)
            boundary = fold_steers(steers)
            if boundary is not None:
                logger.info(
                    "debate.steer.applied",
                    execution_id=execution_id,
                    round_no=round_no,
                    decision=boundary.decision.value,
                    n=len(steers),
                )
            return boundary

        started_at = time.monotonic()
        try:
            result = await moderator.run(
                config,
                run_round=runner,
                run_cross_exam=cross_exam_runner,
                run_closing=closing_runner,
                on_round_start=_emit_round_start,
                on_round=_emit_round,
                on_round_boundary=_round_boundary if self._ambient_armed else None,
            )
        except PlanOnlyAbortError:
            # First-round run_plan already emitted; end the CEO turn without debaters.
            summary = "[plan-only] 已记录辩论计划，跳过辩手执行。"
            logger.info("debate.plan_only_done", motion=config.motion[:80])
            return ToolResult(
                tool_call_id="",
                success=True,
                output=summary,
                effect=ToolEffect.HANDOFF,
                final_text=summary,
            )
        except Exception as exc:  # noqa: BLE001 — 辩论崩溃降级为工具失败，让 CEO 回落
            logger.exception("debate.failed", motion=config.motion[:80])
            return err(f"辩论执行失败：{exc}。可重试，或改用 delegate 单独处理。")

        duration_ms = int((time.monotonic() - started_at) * 1000)
        account_moderator(self, moderator, moderator_run_id, moderator_model, result, duration_ms)
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
