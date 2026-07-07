"""DebateTool — CEO 发起结构化辩论 / 交叉审查的编排原语。"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, new_id
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import default_turn_profiles as default_profile_set
from agentcore.llm.provider.protocol import LLMProvider
from agentcore.runtime.debate import (
    DebateConfig,
    DebateSeed,
    Moderator,
    RoundBoundary,
    RoundDecision,
    RoundPolicy,
    RoundResult,
)
from agentcore.runtime.events import (
    EventSink,
    debate_result,
    debate_round,
    debate_round_decision_required,
    debate_round_decision_resolved,
    debate_round_started,
    run_started,
)
from agentcore.runtime.interaction import InteractionKind
from agentcore.tools.builtin.debate.events import account_moderator, moderator_plan_event
from agentcore.tools.builtin.debate.rounds import (
    make_closing_runner,
    make_cross_exam_runner,
    make_round_runner,
)
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
    from agentcore.runtime.interaction import InteractionRegistry
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
        registry: InteractionRegistry | None = None,
        conversation_id: str = "",
        round_decision_timeout: float = 0.0,
        interactive_armed: bool = False,
        prior_seed: DebateSeed | None = None,
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
        # 交互式逐轮（opt-in）的挂起桥接：``registry`` 是统一交互桥（与 ask_user/escalate 同一个）；
        # ``interactive_armed`` 是「有活跃用户」闸（同 ask_user 的 checkpoint 闸）——无活跃用户
        # （自治 / handoff）即便 debate(interactive=true) 也回落到主持人自判收敛，不挂起。
        self._registry = registry
        self._conversation_id = conversation_id
        self._round_decision_timeout = round_decision_timeout
        self._interactive_armed = interactive_armed
        # 结构化补轮·B（可逆叫停）：上一场辩论的结构化种子（前端从收场卡发起续辩时直传，经
        # pipeline 线到此）。非空 ⇒ 本回合的 debate 调用是「续辩」：主持人 _frame 正交于上一场
        # 焦点、首轮辩手读到上一场摘要。``None`` = 全新辩论（逐字回退，零行为变化）。
        self._prior_seed = prior_seed
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
        logger.info("debate.started", form=form.value, sides=len(sides), motion=motion[:80])

        moderator = Moderator(provider=self._llm, model=moderator_model)
        runner = make_round_runner(self, execution_id, moderator_run_id, config)
        # 质询回合（P1）：注入质询作答 runner；主持人仅在【认真辩透 + 对抗形态】开启质询 beat
        # （见 Moderator._cross_exam_enabled），快速对碰 / 圆桌自动跳过，零额外开销。
        cross_exam_runner = make_cross_exam_runner(self, execution_id, moderator_run_id, config)
        # 结辩收束（P4）：注入结辩 runner；主持人仅在【认真辩透 + 对抗形态】收场后开结辩 beat
        # （见 Moderator._closing_enabled），快速对碰 / 圆桌 / 全员失败自动跳过，零额外开销。
        closing_runner = make_closing_runner(self, execution_id, moderator_run_id, config)

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

        # 交互式逐轮（opt-in）：仅当 CEO 显式 interactive=true、本回合有活跃用户（armed）、交互桥
        # 已接入且超时为正时挂起请示用户；否则 on_round_boundary=None ⇒ 主持人按裁判自判收敛（与
        # 非交互辩论逐字同辙，零行为变化）。挂起复用与 ask_user/escalate 同一条交互桥。
        interactive = (
            bool(arguments.get("interactive"))
            and self._interactive_armed
            and self._registry is not None
            and self._round_decision_timeout > 0
        )

        async def _round_boundary(
            *, round_no: int, result: RoundResult, converged: bool, max_rounds: int
        ) -> RoundBoundary | None:
            assert self._registry is not None  # gated by `interactive`
            decision_id = f"debate_round_{new_id()}"
            rationale = result.verdict.rationale
            payload = {
                "execution_id": execution_id,
                "moderator_run_id": moderator_run_id,
                "decision_id": decision_id,
                "round_no": round_no,
                "focus": result.focus,
                "summary": result.summary,
                "converged": converged,
                "rationale": rationale,
            }
            try:
                outcome = await self._registry.suspend(
                    decision_id,
                    self._conversation_id,
                    kind=InteractionKind.DEBATE_ROUND,
                    payload=payload,
                    timeout=self._round_decision_timeout,
                    on_suspended=lambda: self._sink.emit(
                        debate_round_decision_required(
                            execution_id=execution_id,
                            moderator_run_id=moderator_run_id,
                            decision_id=decision_id,
                            round_no=round_no,
                            focus=result.focus,
                            summary=result.summary,
                            converged=converged,
                            rationale=rationale,
                        )
                    ),
                )
            except TimeoutError:
                # 用户未应答 ⇒ 交回裁判自动收敛（返回 None）；emit resolved=timeout 让前端收卡。
                logger.info("debate.round_decision.timeout", decision_id=decision_id, r=round_no)
                self._sink.emit(
                    debate_round_decision_resolved(
                        execution_id=execution_id,
                        moderator_run_id=moderator_run_id,
                        decision_id=decision_id,
                        decision="timeout",
                    )
                )
                return None
            decision = str(outcome.get("decision") or "").strip()
            focus = str(outcome.get("focus") or "").strip()
            # 追问（与 focus 正交）：要下一轮辩手正面回答的问题，可定向某方（ask_target=side key）。
            ask = str(outcome.get("ask") or "").strip()
            ask_target = str(outcome.get("ask_target") or "").strip()
            self._sink.emit(
                debate_round_decision_resolved(
                    execution_id=execution_id,
                    moderator_run_id=moderator_run_id,
                    decision_id=decision_id,
                    decision=decision or "continue",
                    focus=focus,
                )
            )
            if decision == "conclude":
                # 收场仍带追问 ⇒ 主持人记为未应答留痕（无后续轮可答）。
                return RoundBoundary(
                    decision=RoundDecision.CONCLUDE, ask=ask, ask_target=ask_target
                )
            # continue（含未知值兜底）：续辩；focus 非空=「加角度」、ask 非空=追问注入下一轮。
            return RoundBoundary(
                decision=RoundDecision.CONTINUE, focus=focus, ask=ask, ask_target=ask_target
            )

        started_at = time.monotonic()
        try:
            result = await moderator.run(
                config,
                run_round=runner,
                run_cross_exam=cross_exam_runner,
                run_closing=closing_runner,
                on_round_start=_emit_round_start,
                on_round=_emit_round,
                on_round_boundary=_round_boundary if interactive else None,
                seed=self._prior_seed,
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
