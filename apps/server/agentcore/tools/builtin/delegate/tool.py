"""DelegateTool — CEO main-agent orchestration primitive."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.text import clip_preview
from agentcore.core.types import ToolApproval, ToolCategory, new_id
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import default_turn_profiles as default_profile_set
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink, plan_revised
from agentcore.tools.builtin.delegate.drive import drive
from agentcore.tools.builtin.delegate.plan_events import plan_event
from agentcore.tools.builtin.delegate.schema import (
    DELEGATE_DESCRIPTION,
    DELEGATE_PARAMETERS,
)
from agentcore.tools.builtin.delegate.steer import apply_steer, record_plan_snapshot
from agentcore.tools.builtin.delegate.supervised import (
    SupervisedRun,
    apply_replan,
    finalize_stopped,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.ports import ClientRequestBridge
    from agentcore.runtime.runs.notewall import NoteWall
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.scheduler import BoundaryReason
    from agentcore.runtime.runs.types import RunSpec, RunState
    from agentcore.runtime.sessions import SessionSaver, SessionStore
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

logger = get_logger(__name__)


def _should_auto_light_delegate(tasks_raw: list[Any]) -> bool:
    """True when a single dependency-free worker needs no multi-agent coordination."""
    if len(tasks_raw) != 1:
        return False
    task = tasks_raw[0]
    if not isinstance(task, dict):
        return False
    if task.get("depends_on"):
        return False
    return not (task.get("checkpoint_after") or task.get("bind_after_deps"))


# Cap on how many nodes `delegate.started` lists by name/task — a big fan-out shouldn't
# balloon one log line; `nodes` still carries the true total.
_DELEGATE_LOG_AGENTS_CAP = 12


class DelegateTool:
    """CEO-agent tool that delegates sub-tasks to a Run plan and returns their
    products for the CEO to synthesize (non-terminal, Option 1)."""

    def __init__(
        self,
        *,
        llm: OpenAICompatibleProvider,
        sink: EventSink,
        system_prompt: str,
        user_message: str,
        history: list[dict],
        tools: ToolRegistry,
        base_tool_context: ToolContext,
        profile_set: ProfileSet | None = None,
        max_parallel: int | None = None,
        captain_run_id: str | None = None,
        approval_gate: ApprovalGate | None = None,
        session_store: SessionStore | None = None,
        session_saver: SessionSaver | None = None,
        conversation_id: str | None = None,
        registry: ClientRequestBridge | None = None,
        checkpoint_timeout_seconds: float = 0.0,
        checkpoint_enabled: bool = False,
        message_id: str | None = None,
        suspension_saver: SuspensionSaver | None = None,
        suspension_deleter: SuspensionDeleter | None = None,
        folder_id: str | None = None,
        memory_enabled: bool = True,
        depth: int = 0,
    ) -> None:
        self._llm = llm
        self._sink = sink
        self._system_prompt = system_prompt
        self._user_message = user_message
        self._history = history
        self._tools = tools
        self._base_tool_context = base_tool_context
        self._profile_set = profile_set or default_profile_set()
        self._max_parallel = max_parallel
        self._approval_gate = approval_gate
        self._captain_run_id = captain_run_id
        self._session_store = session_store
        self._session_saver = session_saver
        self._depth = depth
        self._conversation_id = conversation_id
        self._registry = registry
        self._checkpoint_timeout_seconds = checkpoint_timeout_seconds
        self._checkpoint_enabled = checkpoint_enabled
        self._message_id = message_id
        self._suspension_saver = suspension_saver
        self._suspension_deleter = suspension_deleter
        # Turn-level project scope, carried purely so a durable plan_review pause captures it
        # into the frame — the resumed toolset re-wires consult_memory to the same project
        # (Agent记忆与知识系统 §二). Not used by the delegate drive itself.
        self._folder_id = folder_id
        # Same capture-only role: the memory master switch rides the frame so resume re-wires
        # consult_memory exactly as this turn did (off ⇒ stays off).
        self._memory_enabled = memory_enabled
        self._children: list[DelegateTool] = []
        self._calls = 0
        # Cumulative sub-workers spawned by this captain (worker leads only).
        self._sub_workers_spawned = 0
        from agentcore.runtime.costing import WorkerResultAccumulator

        self._acc = WorkerResultAccumulator()
        self._supervised: SupervisedRun | None = None
        self._pending_boundary: tuple[BoundaryReason, list[RunSpec]] | None = None
        # 挂起即收口 (②): set by the CHECKPOINT boundary hook when it finalizes the turn at a
        # plan_review pause (frame saved) — ``drive`` reads it after the scheduler soft-pauses
        # and returns a SUSPEND ToolResult. False on every ordinary drive.
        self._pending_pause: bool = False
        # 团队便签墙 (§2.2 通 / §2.3 合·对账): the most recent batch's wall,
        # set by ``drive`` when it
        # builds the executor so the CEO finalize (``format_for_ceo``, both the normal-终态 and the
        # ``replan(stop)`` finalize_stopped paths) can fold the team's outstanding 决定 / 认领 into
        # 语义边界对账. None until a batch runs (a CEO that never delegated has no wall).
        self._note_wall: NoteWall | None = None
        # Turn-level team consensus (team_brief): survives across delegate calls in one CEO turn.
        self._team_brief: str | None = None

    @property
    def usage(self) -> dict[str, int]:
        return self._acc.usage

    @property
    def run_ledger(self) -> list[RunCost]:
        return self._acc.run_ledger

    @property
    def citations(self) -> list[dict[str, Any]]:
        return self._acc.citations

    @property
    def collab(self) -> dict[str, int]:
        """Turn-level 协作质量 tally (学·度量 §2.5): boundary_yields / scope_signals /
        escalations, rolled up across this turn's batches (and nested sub-teams)."""
        return self._acc.collab

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="delegate",
            description=DELEGATE_DESCRIPTION,
            parameters=DELEGATE_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        from agentcore.runtime.runs import build_run_plan

        # 拆·playbook 固化 (§2.1): a固化形状 instantiates the whole tasks array, then flows through
        # the SAME pipeline below as a hand-written one (纯加法). playbook XOR tasks — expanding a
        # playbook AND passing tasks is ambiguous, so reject rather than silently pick one.
        playbook = arguments.get("playbook")
        if playbook is not None:
            from agentcore.runtime.runs.playbooks import expand_playbook

            if not isinstance(playbook, str) or not playbook.strip():
                msg = "playbook 必须是非空字符串（playbook 名）。"
                return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
            if arguments.get("tasks"):
                msg = (
                    "playbook 与 tasks 二选一：用 playbook 时把槽位放进 "
                    "playbook_args，别同时传 tasks。"
                )
                return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
            tasks_raw, pb_errors = expand_playbook(playbook.strip(), arguments.get("playbook_args"))
            if pb_errors:
                msg = "playbook 实例化失败：" + "；".join(pb_errors)
                logger.info("delegate.playbook_rejected", playbook=playbook, errors=pb_errors)
                return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
            logger.info("delegate.playbook", playbook=playbook.strip(), nodes=len(tasks_raw))
        else:
            tasks_raw = arguments.get("tasks")
            if not isinstance(tasks_raw, list) or not tasks_raw:
                msg = "'tasks' 必须是非空数组：每个元素至少包含 role 和 task。"
                return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        valid_tools = {s.name for s in self._tools.list_all()}
        complexity_hint = arguments.get("complexity_hint", "standard")
        if "complexity_hint" not in arguments and _should_auto_light_delegate(tasks_raw):
            complexity_hint = "light"
            logger.debug("delegate.complexity_hint_inferred", hint="light")
        # 未显式设置时默认授予委派能力（depth 上限由 executor 执行）
        for task in tasks_raw:
            if isinstance(task, dict) and "can_delegate" not in task:
                task["can_delegate"] = True
        if self._depth >= 1:
            from agentcore.runtime.runs.constants import MAX_WORKER_SUBDELEGATIONS

            new_nodes = len(tasks_raw)
            if self._sub_workers_spawned + new_nodes > MAX_WORKER_SUBDELEGATIONS:
                msg = (
                    f"子团队扇出已达上限（已派出 {self._sub_workers_spawned} 个 sub-worker，"
                    f"本次 {new_nodes} 个，上限 {MAX_WORKER_SUBDELEGATIONS}）——请合并任务或分批。"
                )
                logger.info(
                    "delegate.sub_fanout_rejected",
                    spawned=self._sub_workers_spawned,
                    requested=new_nodes,
                    cap=MAX_WORKER_SUBDELEGATIONS,
                )
                return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        self._calls += 1
        # 冻结本次委派调用的序号：同回合并发的多个 delegate 调用共享 self._calls，若在完成侧
        # 惰性读取会把每个批次的 completed / synthesis 日志都错记到「最后自增到的序号」。这里
        # 立刻定格，透传给 drive → format_for_ceo 用于完成侧日志。
        call_idx = self._calls
        prefix = f"del_{new_id()}"
        plan, errors = build_run_plan(
            tasks_raw,
            valid_tools=valid_tools,
            id_prefix=prefix,
            parent_run_id=self._captain_run_id,
            depth=self._depth + 1,
        )
        if errors:
            msg = "委派任务无效：" + "；".join(errors)
            logger.info("delegate.rejected", errors=errors)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        if self._depth >= 1:
            self._sub_workers_spawned += len(plan.nodes)

        from agentcore.tools.builtin.delegate.seed_notes import (
            parse_seed_notes,
            parse_team_brief,
        )

        seed_notes, seed_err = parse_seed_notes(arguments.get("seed_notes"))
        if seed_err:
            return ToolResult(tool_call_id="", success=False, output=seed_err, error=seed_err)
        brief_raw = arguments.get("team_brief")
        if brief_raw is not None:
            brief, brief_err = parse_team_brief(brief_raw)
            if brief_err:
                return ToolResult(tool_call_id="", success=False, output=brief_err, error=brief_err)
            self._team_brief = brief

        record_plan_snapshot(plan)

        execution_id = self._base_tool_context.execution_id or new_id()
        from agentcore.runtime.audit.hooks import on_delegate_plan

        on_delegate_plan(
            execution_id=execution_id,
            plan=plan,
            captain_run_id=self._captain_run_id,
        )
        self._sink.emit(plan_event(self, execution_id, plan))
        # 决策可观测: who + what got delegated (the「派了谁、干什么」input basis), not just a
        # node count. `parallel` = first-wave width (nodes with no deps → run concurrently), so
        # 扇出 vs 串行 is visible offline. `agents` is capped to keep the line bounded on a big fan-out.
        logger.info(
            "delegate.started",
            nodes=len(plan.nodes),
            call=call_idx,
            parallel=sum(1 for n in plan.nodes if not n.depends_on),
            complexity_hint=complexity_hint,
            plan=[
                {"id": n.run_id, "role": n.role, "depends_on": n.depends_on}
                for n in plan.nodes
            ],
            waves=[
                [n.run_id for n in wave]
                for wave in plan.waves()
            ],
            agents=[
                f"{n.role or n.agent_name or n.run_id}: {clip_preview(n.task, 80)}"
                for n in plan.nodes[:_DELEGATE_LOG_AGENTS_CAP]
            ],
        )
        # retry-failed: if a retry seed is set (from retry_failed_chat), use it
        # so workers that already succeeded are skipped by the WaveScheduler.
        from agentcore.runtime.retry import retry_failed_targets as _retry_failed_targets_var
        from agentcore.runtime.retry import retry_seed as _retry_seed_var

        _retry = _retry_seed_var.get(None)
        _failed_targets = _retry_failed_targets_var.get(None)
        # Only use the seed once (for the first delegate call); clear it so a
        # second delegate in the same turn doesn't inherit stale seeds.
        if _retry is not None:
            _retry_seed_var.set(None)
        if _failed_targets is not None:
            _retry_failed_targets_var.set(None)
            from agentcore.runtime.audit.hooks import on_run_retry

            for target in _failed_targets:
                run_id = str(target.get("run_id") or "")
                if not run_id:
                    continue
                on_run_retry(
                    run_id=run_id,
                    attempt=1,
                    source="retry_failed",
                    error=target.get("error"),
                )

        return await drive(
            self,
            plan,
            execution_id=execution_id,
            seed_completed=_retry,
            finalize=bool(arguments.get("finalize")),
            seed_notes=seed_notes,
            complexity_hint=complexity_hint,
            call_idx=call_idx,
            completion_criteria=arguments.get("completion_criteria"),
            # Omit → True（默认协调）；显式 false → 经典阻塞。勿用 bool(get())，
            # 否则缺省会落成 False，与 schema default 不一致。
            coordinate=(
                bool(arguments["coordinate"])
                if "coordinate" in arguments
                else True
            ),
        )

    async def _drive(
        self,
        plan: RunPlan,
        *,
        execution_id: str,
        seed_completed: dict[str, RunState] | None,
        finalize: bool,
        seed_notes: list[dict[str, str]] | None = None,
        complexity_hint: str = "standard",
    ) -> ToolResult:
        return await drive(
            self,
            plan,
            execution_id=execution_id,
            seed_completed=seed_completed,
            finalize=finalize,
            seed_notes=seed_notes or [],
            complexity_hint=complexity_hint,
        )

    async def resume_plan(
        self,
        plan: RunPlan,
        seed_completed: dict[str, RunState],
        *,
        decision: CheckpointDecision,
        note: str,
        checkpoint_run_ids: set[str],
        execution_id: str,
    ) -> ToolResult:
        if decision is CheckpointDecision.STOP:
            return await finalize_stopped(self, plan, seed_completed)

        if decision is CheckpointDecision.ADJUST and note.strip():
            apply_steer(plan, seed_completed, checkpoint_run_ids, note.strip())
        # Resume never re-runs the original execute() path, so re-emit run_plan here:
        # the frontend drops the pause bubble on message_start and must re-bind the DAG
        # under the new streaming assistant before worker frames arrive.
        self._sink.emit(plan_event(self, execution_id, plan))
        logger.info(
            "delegate.resume_plan",
            execution_id=execution_id,
            decision=decision.value,
            nodes=len(plan.nodes),
        )
        # coordinate=False 恒真且正确，非漏配：plan_review/team_preview 挂起帧只可能出自
        # 经典（非协调）路径——协调 gate（should_enter_coordination）在 preview/波边界
        # checkpoint 之前就臂起后台协调并 return（drive.py），协调态下波边界暂停只化作
        # BOUNDARY_YIELD 协调事件（host.py）、绝不生成 TurnSuspension。故被 resume 的
        # plan_review/team_preview 帧按定义即经典 run，续跑保持经典。协调 run 仅经 ask_user
        # 挂起，其 resume 在 settle.py 重建 CoordinationSession。
        return await drive(
            self, plan, execution_id=execution_id, seed_completed=seed_completed, finalize=False,
            coordinate=False,
        )

    async def replan(self, arguments: dict[str, Any]) -> ToolResult:
        from agentcore.runtime.runs import BoundaryReason

        sup = self._supervised
        if sup is None:
            msg = (
                "当前没有待续跑的受监督计划。replan 仅在 delegate 让出边界（输出『计划已"
                "让出』）或部分队员失败/跳过后可用；要发起新任务请用 delegate。"
            )
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        binds = arguments.get("binds") or []
        steers = arguments.get("steers") or []
        adds = arguments.get("add") or []
        stop = bool(arguments.get("stop"))
        if (
            not isinstance(binds, list)
            or not isinstance(steers, list)
            or not isinstance(adds, list)
        ):
            msg = "replan 的 binds / steers / add 必须是数组。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        if sup.reason is BoundaryReason.BIND and not stop and not binds:
            msg = (
                "replan 需要 binds 定稿至少一个『待定稿』步骤，或设 stop=true 收口"
                "（仅 steers / add 不能让待定稿步骤运行起来）。"
            )
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        # Snapshot the pre-add node ids so we can tell which nodes apply_replan appended
        # (it mutates the plan in place) — those drive the re-emitted run_plan below.
        ids_before = {n.run_id for n in sup.plan.nodes}
        errors = apply_replan(self, sup.plan, sup.completed, binds, steers, adds)
        if errors:
            msg = "replan 无效：" + "；".join(errors)
            logger.info("replan.rejected", errors=errors)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        self._supervised = None
        record_plan_snapshot(sup.plan)
        added_nodes = [n for n in sup.plan.nodes if n.run_id not in ids_before]
        # 波边界追加节点 (设计 §7.1): re-emit run_plan so the grown DAG's new nodes merge onto
        # the live graph (same execution_id → the frontend folds merge, never reset, exactly
        # like a second delegate batch). Journaled, so the appended nodes replay on reload;
        # without this their run_started/run_completed would target unknown ids and be dropped.
        if added_nodes:
            self._sink.emit(plan_event(self, sup.execution_id, sup.plan))
        # 「计划已调整」轻痕迹 (设计 §7.2): surface the autonomous re-bind / re-steer onto the
        # affected graph nodes (bind=据上游证据定稿待绑定步骤; steer=偏离后操舵未跑步骤). A node
        # both bound AND steered reads as the bigger event (bind). Emitted only when something
        # changed — a no-op SCOPE resume (replan() 续跑) sends nothing. Appended nodes are NEW
        # (not revised), so they ride the run_plan merge above, not this trace.
        revised: dict[str, str] = {}
        for b in binds:
            rid = str(b.get("run_id") or "").strip() if isinstance(b, dict) else ""
            if rid:
                revised[rid] = "bind"
        for s in steers:
            rid = str(s.get("run_id") or "").strip() if isinstance(s, dict) else ""
            if rid and rid not in revised:
                revised[rid] = "steer"
        if revised:
            self._sink.emit(
                plan_revised(
                    execution_id=sup.execution_id,
                    revisions=[{"run_id": rid, "kind": kind} for rid, kind in revised.items()],
                )
            )
        logger.info(
            "replan.applied",
            binds=len(binds),
            steers=len(steers),
            adds=len(added_nodes),
            stop=stop,
        )
        from agentcore.runtime.audit.hooks import on_replan

        on_replan(
            execution_id=sup.execution_id,
            binds=binds,
            steers=steers,
            adds=len(added_nodes),
            stop=stop,
        )
        if stop:
            return await finalize_stopped(self, sup.plan, sup.completed)
        return await drive(
            self,
            sup.plan,
            execution_id=sup.execution_id,
            seed_completed=sup.completed,
            finalize=sup.finalize,
            coordinate=False,
        )

    async def dispose_open_supervised(self) -> ToolResult | None:
        """Turn-end disposition of a plan the CEO yielded at a boundary but never resumed
        (受监督的波循环 P5「Edge」: turn 末仍开着的 supervised run).

        The yield path returns the boundary brief WITHOUT folding the已完成 workers' usage /
        ledger / citations — those fold on the resume's terminal drive. If the captain loop
        ends first (the CEO answered without a ``replan``, hit MAX_ROUNDS, errored upstream…),
        that spend would be stranded (unbilled, sources unshown). Treat it as an implicit
        ``stop``: fold the completed work in and materialise the un-run tail SKIPPED — the
        exact ``replan(stop=true)`` path — then release the dangling state. No-op when nothing
        is paused. The host calls this once at turn end; the returned ToolResult is unused (the
        CEO already moved on), it exists only to reuse the stop path verbatim.
        """
        sup = self._supervised
        if sup is None:
            return None
        self._supervised = None
        logger.info(
            "delegate.supervised_disposed",
            reason=sup.reason.value,
            completed=len(sup.completed),
            pending=sum(1 for n in sup.plan.nodes if n.run_id not in sup.completed),
        )
        return await finalize_stopped(self, sup.plan, sup.completed)
