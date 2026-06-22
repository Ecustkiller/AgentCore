"""debate: CEO 发起结构化辩论 / 交叉审查的编排原语（主持人驱动）。

CEO 把「该不该做 X」「压力测试这个方案」「多视角探讨 Y」这类需要【对抗性多视角思考】的任务，
委派给一个有状态的主持人（:class:`~agentcore.runtime.debate.Moderator`）：主持人内部跑辩论
循环（定议题 → 派各方发言 → 裁判 → 小结 → 决策下一轮 / 收敛），收敛后交回【决策简报 + 交锋
叙事线】双产物。非终结（同 ``delegate``）：产物回到 CEO 循环由 CEO 用自己的声音收尾。

底层不重建：每轮辩手复用现有执行地基——首轮用 ``build_run_plan`` + ``build_agent_executor`` +
``WaveScheduler`` 派一波并行 worker；后续轮用 ``continue_run`` 让同一辩手在【自己的 transcript】
上续写（把对方上轮论点当 feedback 注入），即「辩手跨轮带记忆」，根治旧法「每轮全新失忆
worker」。用量 / 账目 / 引用经 ``WorkerResultAccumulator`` 折算入回合总账，与 ``delegate`` 一致。

→ 见设计: docs/03-AI核心/辩论编排设计.md
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, replace
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, new_id
from agentcore.llm.config import apply_overrides
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.runtime.debate import (
    DebateConfig,
    DebateForm,
    DebateSide,
    Moderator,
    RoundPolicy,
    RoundResult,
    SideTurn,
)
from agentcore.runtime.events import (
    EventSink,
    debate_result,
    debate_round,
    debate_round_started,
    run_completed,
    run_plan,
    run_started,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.debate.types import DebateResult, RoundResult
    from agentcore.runtime.runs.session import RunSession

logger = get_logger(__name__)

# CEO 读取双产物（简报 + 叙事线）作为本工具输出；对齐 delegate 的放宽预算，避免长简报被截断。
_DEBATE_OUTPUT_LIMIT = 16000

# 辩手最小权限工具集（least-privilege）：只给取证类工具（查资料 / 读网页），不给文件 / 代码 /
# 委派 / 提问等副作用工具——辩手职责是论证而非动手改东西，收窄可防跑偏、降多余开销。首轮经
# task 的 tools 字段成为 allow-list，后续轮经 session.spec 自动沿用。
_DEBATER_TOOLS = ("web_search", "read_url")

# 辩手发言长度指引：旧观测里单方动辄数千 token（一条就几十秒），既拖慢又稀释论点。引导「宁深
# 勿长」——聚焦最有力的少数论点，显著降低每轮墙钟与 token。首轮立论与后续轮续写都注入。
_LENGTH_HINT = "聚焦你最有力的 2–3 个论点、约 400–600 字讲透，宁深勿长——不堆砌、不面面俱到。"

_FORM_LABELS = {
    DebateForm.DEBATE: "正反辩论",
    DebateForm.RED_TEAM: "红队挑刺",
    DebateForm.ROUNDTABLE: "多方圆桌",
}

_DEBATE_DESCRIPTION = (
    "对需要【对抗性多视角思考】的问题发起一场结构化辩论 / 交叉审查：由一个主持人逐轮派各方"
    "交锋、判收敛、自停，最后交回【决策简报 + 交锋叙事线】双产物。本工具非终结——产物回到你"
    "的循环，你据此为用户收尾（先给结论与建议，点出仅剩需用户拍板的点）。\n"
    "三形态：debate=正反辩论（选 A 还是 B / 该不该做 X）；red_team=红队挑刺（压力测试某个方案，"
    "把被审方案那一方标 is_subject）；roundtable=多方圆桌（学懂一个有争议话题的观点光谱）。\n"
    "你只需定【参与方与立场】：传 motion（命题）+ form（形态）+ sides（各方，≥2；圆桌建议 ≥3）。"
    "轮数与收敛由主持人自调，你和用户都不设轮数。简单事实问答 / 无对立面的任务不要用本工具。"
)

_DEBATE_PARAMETERS = {
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
                            "机器标识（如 pro/con/red1，"
                            "唯一英文短词，用于跨轮定位）。"
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
                            "仅红队形态：标记被审的【方案方】"
                            "（承受单向攻击并回应修补）。"
                        ),
                    },
                },
                "required": ["key", "name", "stance"],
            },
        },
        "thorough": {
            "type": "boolean",
            "description": "是否认真辩透（默认 true，最小 3 轮）；false=快速单轮对碰。圆桌恒多轮（默认最小 2 轮）。",
        },
    },
    "required": ["motion", "form", "sides"],
}


def _err(msg: str) -> ToolResult:
    return ToolResult(tool_call_id="", success=False, output=msg, error=msg)


def _parse_form(raw: Any) -> DebateForm:
    if isinstance(raw, str):
        try:
            return DebateForm(raw.strip())
        except ValueError:
            pass
    return DebateForm.DEBATE


def _parse_sides(raw: Any) -> tuple[list[DebateSide], str]:
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
            description=_DEBATE_DESCRIPTION,
            parameters=_DEBATE_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        from agentcore.runtime.costing import usage_metadata

        motion = str(arguments.get("motion") or "").strip()
        if not motion:
            return _err("debate 需要 motion（辩论命题 / 要解决的问题）。")
        sides, side_err = _parse_sides(arguments.get("sides"))
        if side_err:
            return _err(side_err)
        form = _parse_form(arguments.get("form"))
        thorough = arguments.get("thorough", True)
        if not isinstance(thorough, bool):
            thorough = True
        policy = RoundPolicy.for_form(form, thorough=thorough)
        config = DebateConfig(motion=motion, form=form, sides=sides, policy=policy)

        execution_id = self._base_tool_context.execution_id or new_id()
        moderator_run_id = f"debate_{new_id()}"
        moderator_model = self._profile_set.agent(config.model_preference).model

        # 先声明主持人节点（CEO 之下、辩手之上的编排角色），辩手节点逐轮声明。
        self._sink.emit(self._moderator_plan_event(execution_id, moderator_run_id, config))
        # 主持人作为完成态节点：开播 run_started（parent=CEO 主气泡 run），收场 run_completed
        # （见 _account_moderator）——团队进度因此把主持人计入并正确收尾，不再永久 pending。
        self._sink.emit(
            run_started(
                moderator_run_id,
                moderator_run_id,
                parent_run_id=self._captain_run_id,
            )
        )
        logger.info(
            "debate.started", form=form.value, sides=len(sides), motion=motion[:80]
        )

        moderator = Moderator(provider=self._llm, model=moderator_model)
        runner = self._make_round_runner(execution_id, moderator_run_id, config)

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
            return _err(f"辩论执行失败：{exc}。可重试，或改用 delegate 单独处理。")

        duration_ms = int((time.monotonic() - started_at) * 1000)
        self._account_moderator(
            moderator, moderator_run_id, moderator_model, result, duration_ms
        )
        # 收场广播完整辩论结构（简报 + 叙事线），前端据此渲染辩论视图；进 journal 可重载回放。
        self._sink.emit(
            debate_result(
                execution_id=execution_id,
                moderator_run_id=moderator_run_id,
                payload=result.to_event_payload(),
            )
        )
        logger.info(
            "debate.done", rounds=len(result.rounds), stop=result.stop_reason
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=result.to_ceo_output(),
            output_limit=_DEBATE_OUTPUT_LIMIT,
            metadata=usage_metadata(self._acc.usage),
        )

    # ── RoundRunner（注入给 Moderator 的「派一轮辩手」实现） ─────────────────
    def _make_round_runner(self, execution_id: str, moderator_run_id: str, config: DebateConfig):
        async def run_round(*, round_no, focus, sides, history):
            if round_no <= 1 or not self._debater_sessions:
                return await self._first_round(execution_id, moderator_run_id, config, focus, sides)
            return await self._next_round(
                execution_id, moderator_run_id, config, round_no, focus, sides, history
            )

        return run_round

    async def _first_round(
        self,
        execution_id: str,
        moderator_run_id: str,
        config: DebateConfig,
        focus: str,
        sides,
    ) -> list[SideTurn]:
        """首轮：build_run_plan 一波并行辩手 → executor → 留人 → 折算 → SideTurn。"""
        from agentcore.runtime.runs import (
            DEFAULT_MAX_PARALLEL,
            BatchMetrics,
            RunPhase,
            RunSession,
            WaveScheduler,
            build_agent_executor,
            build_run_plan,
        )

        sides = list(sides)
        tasks_raw = [
            self._debater_task(config, side, idx, round_no=1, focus=focus)
            for idx, side in enumerate(sides)
        ]
        valid_tools = {s.name for s in self._tools.list_all()}
        plan, errors = build_run_plan(
            tasks_raw,
            valid_tools=valid_tools,
            id_prefix=f"{moderator_run_id}_r1",
            parent_run_id=moderator_run_id,
            depth=self._depth + 2,
        )
        if errors or not plan.nodes:
            logger.warning("debate.round1.build_failed", errors=errors)
            return [self._failed_turn(side, f"{moderator_run_id}_r1_{side.key}") for side in sides]

        # run_id 命名统一：首轮辩手改用语义后缀 `_r1_{side.key}`，与后续轮 continue_run 的
        # `_r{n}_{side.key}` 同构（旧法用 build_run_plan 给扁平批的位置序号 `_r1_1`，与后续轮
        # 漂移）。纯展示口径统一、零行为变化：血缘不靠 run_id 解析（续写经 session.run_id 显式
        # 带 parent_run_id 链回原始 run），key 已由 _parse_sides 保证非空且唯一，sides 与
        # plan.nodes 按声明序一一对应（与下方留人 zip 同前提）。首轮无 depends_on（扁平批），
        # 重命名无内部边需改。这也让真实产物对齐 conformance 向量记载的 `_r1_pro` 契约。
        plan.nodes = [
            replace(
                node,
                run_id=f"{moderator_run_id}_r1_{side.key}",
                agent_id=f"{moderator_run_id}_r1_{side.key}",
            )
            for side, node in zip(sides, plan.nodes, strict=False)
        ]

        self._sink.emit(self._debater_plan_event(execution_id, moderator_run_id, plan))
        worker_gate = (
            self._approval_gate
            if self._base_tool_context.backend.location == "local"
            else None
        )
        executor = build_agent_executor(
            plan=plan,
            llm=self._llm,
            tools=self._tools,
            sink=self._sink,
            base_tool_context=self._base_tool_context,
            profile_set=self._profile_set,
            system_prompt=self._system_prompt,
            user_message=self._user_message,
            execution_id=execution_id,
            approval_gate=worker_gate,
        )
        scheduler = WaveScheduler(self._max_parallel or DEFAULT_MAX_PARALLEL)
        batch_metrics: list[BatchMetrics] = []
        results = await scheduler.run(plan, executor, metrics_sink=batch_metrics)
        if batch_metrics:
            # 调度埋点量化: the debaters fan out as one parallel wave per round — same
            # batch-health read as delegate (avg_parallelism = busy/wall, slot_starved).
            m = batch_metrics[0]
            logger.info(
                "debate.round1.completed",
                nodes=m.nodes,
                width=m.width,
                peak=m.peak_running,
                wall_ms=m.wall_ms,
                busy_ms=m.busy_ms,
                avg_parallelism=round(m.busy_ms / m.wall_ms, 2) if m.wall_ms else 0.0,
                slot_starved=m.slot_starved,
                completed=m.completed,
                failed=m.failed,
                skipped=m.skipped,
            )

        turns: list[SideTurn] = []
        for side, node in zip(sides, plan.nodes, strict=False):
            state = results.get(node.run_id)
            if state is not None:
                self._acc.add_run(node, state, parent_run_id=moderator_run_id)
            if state and state.phase is RunPhase.COMPLETED and state.content.strip():
                self._debater_sessions[side.key] = RunSession(
                    run_id=node.run_id,
                    spec=node,
                    transcript=state.transcript,
                    content=state.content,
                )
                turns.append(
                    SideTurn(side.key, side.name, node.run_id, state.content, ok=True)
                )
            else:
                turns.append(self._failed_turn(side, node.run_id))
        return turns

    async def _next_round(
        self,
        execution_id: str,
        moderator_run_id: str,
        config: DebateConfig,
        round_no: int,
        focus: str,
        sides,
        history,
    ) -> list[SideTurn]:
        """后续轮：各辩手【并行】continue_run 续写（注入对方上轮论点），收齐后按序留人 + 折算。

        与首轮一致地并发派各方（受 ``max_parallel`` 约束）：各方续写各自独立 session、本轮
        feedback 只取上一轮对方论点、互不依赖，故可并发——根治旧法「后续轮逐个 await，墙钟随
        方数线性叠加」。账目 / 留人 / SideTurn 在 gather 收齐后按 ``sides`` 顺序串行回写，与
        串行版的落账次序完全一致（并发只发生在 LLM 调用本身，不碰共享态）。
        """
        from agentcore.runtime.runs import DEFAULT_MAX_PARALLEL, RunPhase, continue_run

        sides = list(sides)
        last_round: RoundResult = history[-1]
        worker_gate = (
            self._approval_gate
            if self._base_tool_context.backend.location == "local"
            else None
        )
        semaphore = asyncio.Semaphore(self._max_parallel or DEFAULT_MAX_PARALLEL)

        async def _continue_side(side: DebateSide):
            session = self._debater_sessions.get(side.key)
            if session is None:
                return None
            revision_run_id = f"{moderator_run_id}_r{round_no}_{side.key}"
            feedback = self._round_feedback(config, side, round_no, focus, last_round)
            async with semaphore:
                return await continue_run(
                    session=session,
                    feedback=feedback,
                    revision_run_id=revision_run_id,
                    llm=self._llm,
                    tools=self._tools,
                    sink=self._sink,
                    base_tool_context=self._base_tool_context,
                    execution_id=execution_id,
                    profile_set=self._profile_set,
                    approval_gate=worker_gate,
                )

        states = await asyncio.gather(*(_continue_side(side) for side in sides))

        turns: list[SideTurn] = []
        for side, state in zip(sides, states, strict=False):
            session = self._debater_sessions.get(side.key)
            revision_run_id = f"{moderator_run_id}_r{round_no}_{side.key}"
            if session is None or state is None:
                turns.append(self._failed_turn(side, revision_run_id))
                continue
            rev_spec = replace(session.spec, run_id=revision_run_id, agent_id=revision_run_id)
            self._acc.add_run(rev_spec, state, parent_run_id=moderator_run_id)
            if state.phase is RunPhase.COMPLETED and state.content.strip():
                # 续写成功：把延展后的 transcript 提交回 session，供下一轮再续写。
                session.transcript = state.transcript
                session.content = state.content
                session.recall_count += 1
                turns.append(
                    SideTurn(side.key, side.name, revision_run_id, state.content, ok=True)
                )
            else:
                turns.append(self._failed_turn(side, revision_run_id))
        return turns

    @staticmethod
    def _failed_turn(side: DebateSide, run_id: str) -> SideTurn:
        return SideTurn(side.key, side.name, run_id, "", ok=False)

    # ── 辩手 prompt 构造 ────────────────────────────────────────────────
    def _debater_task(
        self, config: DebateConfig, side: DebateSide, idx: int, *, round_no: int, focus: str
    ) -> dict[str, Any]:
        """构造首轮单个辩手的 task dict（build_run_plan 入参）。"""
        task = (
            f"你在一场【{_FORM_LABELS.get(config.form, '辩论')}】中代表「{side.name}」。\n"
            f"辩论命题：{config.motion}\n"
            f"你的立场 / 视角：{side.stance}\n"
            f"本轮议题：{focus}\n\n"
            f"{self._role_directive(config, side)}\n"
            f"请就本轮议题给出有力、具体、有论据的论证（这是你的开场立论）。{_LENGTH_HINT}"
        )
        payload: dict[str, Any] = {
            "role": side.name,
            "task": task,
            "objective": f"代表「{side.name}」就「{focus}」立论",
            "system_prompt_supplement": self._side_system(config, side),
            "model_preference": config.model_preference,
            "tools": list(_DEBATER_TOOLS),
            "group": f"debate:{config.form.value}",
            "round": round_no,
        }
        # stance 仅正反 2 方有意义（builder 只认 pro/con，display-only）。
        if config.form is DebateForm.DEBATE and len(config.sides) == 2:
            payload["stance"] = "pro" if idx == 0 else "con"
        return payload

    def _round_feedback(
        self,
        config: DebateConfig,
        side: DebateSide,
        round_no: int,
        focus: str,
        last_round: RoundResult,
    ) -> str:
        """后续轮喂给 continue_run 的 feedback：本轮焦点 + 对方上轮论点 +「只补新论点、勿重述」约束。

        辩手在【自己的 transcript】上续写（已带自己上轮全文），故无需也不应重述自己上轮——明令
        「只补本轮焦点下的新论点 / 新回应」根治冗余轮的「修订 v2 内容相似」（与 ``_frame`` 的焦点
        正交约束一上一下夹击：换维度提问 + 只答新东西）。"""
        opponents = [t for t in last_round.ok_turns if t.side_key != side.key]
        if opponents:
            opp_block = "\n\n".join(f"### {t.side_name}\n{t.content}" for t in opponents)
        else:
            opp_block = "（对方上一轮无有效发言）"
        return (
            f"## 第 {round_no} 轮 · 本轮焦点：{focus}\n"
            f"{self._role_directive(config, side)}\n\n"
            f"对方上一轮的论点如下，请【针对性回应】（驳斥站不住的、承认确有道理的、推进你的立场）：\n"
            f"{opp_block}\n\n"
            f"直接输出你本轮的【完整发言】：**只补本轮焦点下的新论点 / 新回应**，不要重述你上一轮"
            f"已说过的内容、不要复述对方原话、不要罗列改动清单。{_LENGTH_HINT}"
        )

    def _side_system(self, config: DebateConfig, side: DebateSide) -> str:
        base = (
            f"你是一场结构化辩论中的辩手，代表「{side.name}」。坚定但理性地为你的立场辩护："
            "论据具体、直面对方、不偷换概念、不因篇幅长而堆砌。"
        )
        return f"{base}{self._role_directive(config, side)}"

    @staticmethod
    def _role_directive(config: DebateConfig, side: DebateSide) -> str:
        """按形态 / 角色给辩手的差异化指引。"""
        if config.form is DebateForm.RED_TEAM:
            if side.is_subject:
                return (
                    "（你是被审视的方案方：红队会单向施压找你的漏洞，你的职责是诚实回应、能修补"
                    "就给出修补、修不了的风险要坦白承认，不要嘴硬。）"
                )
            return (
                "（你是红队：职责是尽力挖出该方案的风险、漏洞、失败场景与边界条件，单向施压，"
                "不需要你自己另提方案。）"
            )
        if config.form is DebateForm.ROUNDTABLE:
            return (
                "（这是多方圆桌：你代表一个特定视角，平等陈述并回应他人，目标是铺满观点光谱、"
                "贡献你这一视角独有的洞察，而非压倒对方。）"
            )
        return "（这是正反辩论：直接攻防，针锋相对地回应对方最强论点。）"

    # ── 计费 ────────────────────────────────────────────────────────────
    def _account_moderator(
        self,
        moderator: Moderator,
        moderator_run_id: str,
        model: str,
        result: DebateResult,
        duration_ms: int,
    ) -> None:
        """主持人节点收尾：emit run_completed（耗时 + 成本 + 「N 轮·收敛归因」概览，团队图据此
        标完成），并把主持人自身 LLM 调用（议题 / 裁判 / 小结 / 简报）折算成一条主持人节点账目。"""
        from agentcore.llm.pricing import calculate_cost
        from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState

        usage = moderator.usage
        cost = calculate_cost(model, usage)
        summary = result.node_summary
        self._sink.emit(
            run_completed(
                moderator_run_id,
                moderator_run_id,
                output_summary=summary,
                duration_ms=duration_ms,
                role="主持人",
                model=model,
                usage=usage.as_dict(),
                cost=asdict(cost),
            )
        )
        if usage.total_tokens <= 0:
            return  # 无 LLM 用量（极端）则不另记账目，但主持人节点已 emit 完成态。
        spec = RunSpec(
            run_id=moderator_run_id,
            agent_id=moderator_run_id,
            task="主持辩论",
            role="主持人",
            model_preference="strong",
        )
        state = RunState(
            phase=RunPhase.COMPLETED,
            model=model,
            usage=usage.as_dict(),
            cost=asdict(cost),
            rounds=moderator.llm_rounds,
        )
        self._acc.add_run_cost(spec, state, parent_run_id=self._captain_run_id)
        self._acc.add_usage(usage.as_dict())

    # ── 事件 ────────────────────────────────────────────────────────────
    def _moderator_plan_event(self, execution_id: str, moderator_run_id: str, config: DebateConfig):
        """声明主持人节点（CEO 之下、辩手之上的编排角色）。CEO 不进图——与 delegate 一致，
        CEO 是主气泡：主持人 ``parent_run_id`` 引用 CEO 的 captain run（节点不在图），团队图
        因此呈现 主持人→辩手 的树。主持人随后走 run_started/run_completed 完整生命周期。"""
        label = _FORM_LABELS.get(config.form, "辩论")
        agents: list[dict[str, Any]] = [
            {
                "id": moderator_run_id,
                "role": "主持人",
                "model_preference": "strong",
                "thinking": True,
                "reasoning_effort": "high",
            }
        ]
        runs: list[dict[str, Any]] = [
            {
                "id": moderator_run_id,
                "agent_id": moderator_run_id,
                "task": f"主持{label}：{config.motion[:60]}",
                "depends_on": [],
                "parent_run_id": self._captain_run_id,
            }
        ]
        return run_plan(
            execution_id=execution_id,
            plan_type="debate",
            task_summary=f"{label}：{config.motion[:60]}",
            agents=agents,
            runs=runs,
        )

    def _debater_plan_event(self, execution_id: str, moderator_run_id: str, plan):
        """声明本轮辩手节点（parent=主持人）。前端 dedupe 跨轮重复声明。"""
        agents = [self._card(n) for n in plan.nodes]
        runs = [self._run_payload(n) for n in plan.nodes]
        return run_plan(
            execution_id=execution_id,
            plan_type="debate",
            task_summary="",
            agents=agents,
            runs=runs,
        )

    def _card(self, node) -> dict[str, Any]:
        profile = apply_overrides(
            self._profile_set.agent(node.model_preference),
            thinking=node.thinking,
            reasoning_effort=node.reasoning_effort,
        )
        return {
            "id": node.agent_id,
            "role": node.role,
            "model_preference": node.model_preference,
            "thinking": profile.thinking,
            "reasoning_effort": profile.reasoning_effort,
        }

    @staticmethod
    def _run_payload(node) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": node.run_id,
            "agent_id": node.agent_id,
            "task": node.task,
            "depends_on": node.depends_on,
            "parent_run_id": node.parent_run_id,
        }
        if node.stance:
            payload["stance"] = node.stance
        if node.group:
            payload["group"] = node.group
        if node.round:
            payload["round"] = node.round
        return payload
