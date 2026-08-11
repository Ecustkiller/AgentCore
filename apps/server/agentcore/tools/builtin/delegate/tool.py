"""DelegateTool — CEO main-agent orchestration primitive."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.text import clip_preview
from agentcore.core.types import (
    DEFAULT_PERMISSION_AXES,
    PermissionAxes,
    ToolApproval,
    ToolCategory,
    ToolEffect,
    new_id,
)
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import default_turn_profiles as default_profile_set
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.delegate.drive import drive
from agentcore.runtime.delegate.plan_events import plan_event
from agentcore.runtime.delegate.steer import apply_steer, record_plan_snapshot
from agentcore.runtime.delegate.supervised import (
    SupervisedRun,
    apply_replan,
    finalize_stopped,
)
from agentcore.runtime.events import EventSink, plan_revised
from agentcore.tools.builtin.delegate.schema import (
    DELEGATE_DESCRIPTION,
    DELEGATE_PARAMETERS,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.ports import ClientRequestBridge
    from agentcore.runtime.runs.notewall import NoteWall
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.scheduler import BoundaryReason
    from agentcore.runtime.runs.types import RunSpec, RunState
    from agentcore.runtime.sessions import SessionLoader, SessionSaver, SessionStore
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

logger = get_logger(__name__)


def _has_wave_boundary_features(tasks_raw: list[Any]) -> bool:
    """True when any task needs BIND / CHECKPOINT / DAG wave-boundary machinery."""
    for task in tasks_raw:
        if not isinstance(task, dict):
            continue
        if task.get("depends_on") or task.get("checkpoint_after") or task.get("bind_after_deps"):
            return True
    return False


def _has_deep_deliverable_signal(tasks_raw: list[Any]) -> bool:
    """True when any task declares ``form=files`` / non-empty ``artifacts``.

    Orchestration shape (single worker, no DAG) is orthogonal to output weight —
    file-shaped deliverable must not be collapsed into auto-light.
    Retired fields (``min_length`` / ``requires_files``) are not consulted.
    """
    for task in tasks_raw:
        if not isinstance(task, dict):
            continue
        raw = task.get("deliverable")
        if not isinstance(raw, dict):
            continue
        if raw.get("form") == "files":
            return True
        arts = raw.get("artifacts")
        if isinstance(arts, list) and any(
            isinstance(a, str) and a.strip() for a in arts
        ):
            return True
    return False


def _should_auto_light_delegate(tasks_raw: list[Any]) -> bool:
    """True when a single dependency-free worker needs no multi-agent coordination.

    Skips auto-light when deliverable is file-shaped (``form=files`` / artifacts)
    so budget mapping can still promote standard → deep.
    ``complexity_hint=light`` no longer stamps short ``max_rounds``; browser tool
    surfaces are not excluded from auto-light for round-budget reasons.
    """
    if len(tasks_raw) != 1:
        return False
    task = tasks_raw[0]
    if not isinstance(task, dict):
        return False
    if _has_wave_boundary_features([task]):
        return False
    return not _has_deep_deliverable_signal([task])


# Cap on how many nodes `delegate.started` lists by name/task — a big fan-out shouldn't
# balloon one log line; `nodes` still carries the true total.
_DELEGATE_LOG_AGENTS_CAP = 12


def _is_same_host_turn_append(active: Any, message_id: str | None) -> bool:
    """True only for same-turn secondary delegate (message_id ≡ host_turn_id).

    Cross-turn adopt keeps the host eid active but this turn's message_id differs
    from ``host_turn_id`` — must not soft-clear ``append_to`` (growth frames need
    divert into the host journal). Empty / unbound ``host_turn_id`` is not same-turn.
    """
    host_tid = (getattr(active, "host_turn_id", None) or "").strip()
    cur_tid = (message_id or "").strip()
    return bool(host_tid) and host_tid == cur_tid


def _waves_ids_for_log(
    plan: RunPlan,
    *,
    host_for_cross_batch: RunPlan | None = None,
) -> list[list[str]]:
    """Wave id lists for ``delegate.started``; tolerate new-batch edges into host."""
    from agentcore.runtime.runs.plan import RunPlan as Plan
    from agentcore.runtime.runs.plan import RunPlanError

    try:
        return [[n.run_id for n in wave] for wave in plan.waves()]
    except RunPlanError:
        if host_for_cross_batch is None:
            raise
        combined = Plan(
            nodes=[*host_for_cross_batch.nodes, *plan.nodes],
            origin=host_for_cross_batch.origin,
        )
        return [[n.run_id for n in wave] for wave in combined.waves()]


class DelegateTool:
    """CEO-agent tool that delegates sub-tasks to a Run plan and returns their
    products for the CEO to synthesize (non-terminal, Option 1).
    """

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.ALWAYS,
    )

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
        session_loader: SessionLoader | None = None,
        conversation_id: str | None = None,
        registry: ClientRequestBridge | None = None,
        checkpoint_timeout_seconds: float | None = None,
        checkpoint_enabled: bool = False,
        message_id: str | None = None,
        suspension_saver: SuspensionSaver | None = None,
        suspension_deleter: SuspensionDeleter | None = None,
        folder_id: str | None = None,
        memory_enabled: bool = True,
        conversation_history_access: bool = True,
        permission_axes: PermissionAxes | None = None,
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
        self._permission_axes = permission_axes or DEFAULT_PERMISSION_AXES
        self._auto_grant_pending = False
        self._captain_run_id = captain_run_id
        self._session_store = session_store
        self._session_saver = session_saver
        self._session_loader = session_loader
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
        # Same capture-only role: the memory gate rides the frame so resume re-wires
        # consult_memory exactly as this turn did (False ⇒ stays off).
        self._memory_enabled = memory_enabled
        self._conversation_history_access = conversation_history_access
        # 跨项目指挥 · 嵌套默认目标桌（父 worker 的 target / 出生）；tasks 省略时继承。
        self._default_target_folder_id: str | None = None
        # 同回合多 local 认领簿（drive 入口 seed）；嵌套子派共享同一簿。
        self._local_root_claims = None
        self._children: list[DelegateTool] = []
        self._calls = 0
        # 同回合上一张协作图 execution_id + plan/seed 快照（成功 kickoff/drive 后写入）；
        # 二次 delegate 无显式 append / 无活跃 live_plan 时自动合入。
        # plan/seed 供无 journal 时（单测 / journal 未落盘）仍能解析 depends_on。
        self._last_graph_execution_id: str | None = None
        self._last_graph_plan: RunPlan | None = None
        self._last_graph_seed: dict[str, RunState] | None = None
        # Cumulative sub-workers spawned by this captain (worker leads only).
        self._sub_workers_spawned = 0
        from agentcore.runtime.costing import WorkerResultAccumulator

        self._acc = WorkerResultAccumulator()
        # 续派次数（CEO continue_from + redirect 热修；不计辩论）— turn_metrics.revises。
        self._continuation_ids: list[str] = []
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
        # Last resolved note-wall coordination mode (wall|none); resume/replan reuse it.
        self._coordination: str = "none"
        # 本批 CEO 预贴便签（execute 解析后暂存）：开工卡挂在 setup_note_wall 之前，
        # 耐久帧从这里捕获（persist_kickoff），否则恢复后 seed 便签永久丢失。
        self._seed_notes: list[dict[str, str]] = []
        # 当前 execute 展开的 playbook 名（team_preview pre-auth 判定用）。
        self._active_playbook: str | None = None
        # 当前 playbook_args（kickoff headline 只读 intensity；手写 tasks 为 None）。
        self._active_playbook_args: dict[str, Any] | None = None
        # 父 worker 带 code_audit_gate 时：嵌套手写 tasks 继承收工纪律（见 audit.apply_*）。
        self._inherit_code_audit_discipline: bool = False
        # Per-call force flag for isomorphic re-delegation (set in execute).
        self._delegate_force: bool = False
        # Turn user-message provenance (harvest closing stamps execution_harvest).
        from agentcore.runtime.delegate.post_close_gate import current_user_message_origin

        self._user_message_origin: str = current_user_message_origin()

    def effective_default_target_folder_id(self) -> str | None:
        """Nested lead inheritance, else bare-chat turn hint from create/resolve.

        Birth-bound sessions ignore the turn hint (omit → workers sit birth desk).
        Does not rewrite ``_default_target_folder_id`` so a later multi-project
        clear on ``turn_target_desk`` still forces explicit targets.
        """
        nested = getattr(self, "_default_target_folder_id", None)
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
        if self._folder_id:
            return None
        hint = getattr(self._base_tool_context, "turn_target_desk", None)
        hinted = getattr(hint, "folder_id", None) if hint is not None else None
        if isinstance(hinted, str) and hinted.strip():
            return hinted.strip()
        return None

    def spawn_lead_subteam(self, captain_run_id: str, captain_depth: int):
        """Mint a nested lead handle (阶段2); construction stays in the tools package."""
        from agentcore.tools.builtin.delegate.nesting import make_lead_subteam

        return make_lead_subteam(self, captain_run_id, captain_depth)

    def _kickoff_system_prompt(self) -> str:
        return self._system_prompt

    def _kickoff_tool_name(self) -> str:
        return "delegate"

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
    def continuation_count(self) -> int:
        """CEO 侧续派次数（continue_from + redirect 热修；不计辩论编排续写）。"""
        n = len(self._continuation_ids)
        for child in self._children:
            n += child.continuation_count
        return n

    def note_continuation(self, run_id: str) -> None:
        """Record a successful CEO-side continuation for turn_metrics.revises."""
        self._continuation_ids.append(run_id)

    def clear_completion_gap_streak(self) -> None:
        """No-op retained: same-gap streak retired with completion_criteria kind (S3)."""

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
        from agentcore.llm.turn_auth_dead import (
            is_turn_auth_dead,
            turn_auth_dead_reject_message,
        )
        from agentcore.runtime.delegate.playbook_declaration import (
            declaration_reject_gate,
            resolve_playbook_declaration,
        )
        from agentcore.runtime.runs import build_run_plan
        from agentcore.runtime.turn.token_budget import (
            current_turn_tokens,
            is_turn_token_ceiling_hit,
            resolve_turn_token_ceiling,
            turn_token_ceiling_reject_message,
        )

        # Turn 级硬顶：禁新派（在飞不 cancel）；与 per-worker ceiling 正交。
        if is_turn_token_ceiling_hit():
            msg = turn_token_ceiling_reject_message()
            logger.info(
                "delegate.turn_token_ceiling_rejected",
                spent=current_turn_tokens(),
                ceiling=resolve_turn_token_ceiling(),
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=msg,
                contract_failure=True,
            )

        # 甲+乙：本回合 API Key 已鉴权死后禁再 delegate 烧调用。
        if is_turn_auth_dead():
            msg = turn_auth_dead_reject_message()
            logger.info("delegate.turn_auth_dead_rejected")
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=msg,
                contract_failure=True,
            )

        # Playbook 声明闸：结构校验；建站/绿场 none 不硬拒。场面账（style/format/delivery）已拆除。
        automation_delivery_warning: str | None = None
        declared_playbook, _none_reason, decl_error = resolve_playbook_declaration(
            arguments,
            user_message=self._user_message or "",
        )
        if decl_error:
            gate = declaration_reject_gate(decl_error)
            logger.info(
                "delegate.playbook_declaration_rejected",
                playbook_id=arguments.get("playbook_id") or arguments.get("playbook"),
                has_tasks=bool(arguments.get("tasks")),
                gate=gate,
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=decl_error,
                contract_failure=True,
            )
        logger.info(
            "delegate.playbook_declaration",
            playbook_id=declared_playbook or "none",
        )

        # 拆·playbook 固化 (§2.1): a固化形状 instantiates the whole tasks array, then flows through
        # the SAME pipeline below as a hand-written one (纯加法). playbook XOR tasks is enforced
        # in resolve_playbook_declaration (and re-checked here as defense in depth).
        playbook = declared_playbook
        if playbook is not None:
            from agentcore.runtime.delegate.playbook_declaration import (
                PLAYBOOK_TASKS_XOR_MSG,
            )
            from agentcore.runtime.runs.playbooks import (
                collect_playbook_notes,
                expand_playbook,
            )

            if arguments.get("tasks"):
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=PLAYBOOK_TASKS_XOR_MSG,
                    # 契约自纠拒绝——勿进熔断（CEO 连试换 none/去掉 tasks 会误禁用）。
                    contract_failure=True,
                )
            # Mechanism: pass turn user line so playbooks (e.g. multi_lens synthesizer)
            # can inject proposition-fidelity anchors without relying on CEO-filled topic.
            tasks_raw, pb_errors = expand_playbook(
                playbook,
                arguments.get("playbook_args"),
                user_message=self._user_message,
                conversation_id=self._conversation_id or "",
            )
            if pb_errors:
                msg = "playbook 实例化失败：" + "；".join(pb_errors)
                logger.info("delegate.playbook_rejected", playbook=playbook, errors=pb_errors)
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )
            self._active_playbook = playbook
            raw_args = arguments.get("playbook_args")
            self._active_playbook_args = (
                dict(raw_args) if isinstance(raw_args, dict) else None
            )
            playbook_notes = collect_playbook_notes(tasks_raw)
            logger.info(
                "delegate.playbook",
                playbook=playbook,
                nodes=len(tasks_raw),
                notes=len(playbook_notes),
            )
            # MLR keep 标记延后到真正开跑（team_preview CONTINUE / pre-auth 跳过），
            # 避免 STOP / 调度失败仍挡住回合收尾 orphan。
        else:
            self._active_playbook = None
            self._active_playbook_args = None
            playbook_notes = []
            tasks_raw = arguments.get("tasks")
            if not isinstance(tasks_raw, list) or not tasks_raw:
                msg = "'tasks' 必须是非空数组：每个元素至少包含 role 和 task。"
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )

        # 演讲/PPT 场面账已拆除：不再因 format ledger 硬拒 pptx→md。
        presentation_format_warning: str | None = None

        valid_tools = {s.name for s in self._tools.list_all()}
        complexity_hint = arguments.get("complexity_hint", "standard")
        self._delegate_force = bool(arguments.get("force"))
        if "complexity_hint" not in arguments and _should_auto_light_delegate(tasks_raw):
            complexity_hint = "light"
            # info 级：档位归责的关键决策事件，debug 级曾导致线上排查只能靠 demo_tape 反推。
            logger.info("delegate.complexity_hint_inferred", hint="light")
        elif complexity_hint == "light" and _has_wave_boundary_features(tasks_raw):
            # 显式 light 与 DAG/波边界并存时忽略 light（避免关掉 on_boundary）。
            # 已删字数字段 / form=files / artifacts alone 不挡 light（修码快修）。
            complexity_hint = "standard"
            logger.info(
                "delegate.complexity_hint_ignored",
                reason="wave_boundary_features",
            )

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
                return ToolResult(tool_call_id="", success=False, output="", error=msg)
        # 消费者漏边：task 写明吃同批队友产出但 depends_on 为空 → 软告警一次，不拒收入图。
        # playbook 展开后的 tasks 也过闸；有边则无告警。引擎不猜边改图。
        from agentcore.runtime.delegate.consumer_deps import (
            check_consumer_missing_depends,
        )

        consumer_deps_warn = check_consumer_missing_depends(tasks_raw)
        if consumer_deps_warn:
            logger.info(
                "delegate.consumer_deps_soft_warn",
                task_count=len(tasks_raw),
                hint=consumer_deps_warn[:200],
            )

        # 设计+实现同 grant：单 task artifacts/文案同时含设计与实现且未结构拆开 → 软告警一次。
        # 不拒收、不自动拆波改图。
        from agentcore.runtime.delegate.design_impl_slice import (
            check_design_impl_same_grant,
        )

        design_impl_warn = check_design_impl_same_grant(tasks_raw)
        if design_impl_warn:
            logger.info(
                "delegate.design_impl_same_grant_soft_warn",
                task_count=len(tasks_raw),
                hint=design_impl_warn[:200],
            )

        # 根委派切片诚实：单节点手写写工程且无结构钉 → 软告警一次。
        # 不拒收、不改图；嵌套扇出为合法等价路径（文案明示）。
        from agentcore.runtime.delegate.root_slice_honesty import (
            check_root_slice_honesty,
        )

        root_slice_warn = check_root_slice_honesty(
            tasks_raw,
            depth=int(getattr(self, "_depth", 0) or 0),
            playbook=playbook if isinstance(playbook, str) else None,
            finalize=bool(arguments.get("finalize")),
        )
        if root_slice_warn:
            logger.info(
                "delegate.root_slice_honesty_soft_warn",
                task_count=len(tasks_raw) if isinstance(tasks_raw, list) else 0,
                hint=root_slice_warn[:200],
            )

        # §4.2b·2b / 改法④A：无出生且写盘缺目标 → 先静默建云桌，再闸。
        # 裸聊同回合唯一 create/resolve / auto 可经 turn_target_desk 继承缺省目标。
        from agentcore.runtime.delegate.target_desktop import (
            ensure_bare_chat_auto_cloud_desk,
            gate_bare_chat_requires_target,
        )

        tasks_for_gate = tasks_raw if isinstance(tasks_raw, list) else []
        await ensure_bare_chat_auto_cloud_desk(
            session_folder_id=self._folder_id,
            tasks_raw=tasks_for_gate,
            default_target_folder_id=self.effective_default_target_folder_id(),
            turn_target_desk=getattr(
                self._base_tool_context, "turn_target_desk", None
            ),
            user_id=getattr(self._base_tool_context, "user_id", "") or "",
            conversation_id=self._conversation_id
            or getattr(self._base_tool_context, "conversation_id", None),
            user_message=self._user_message,
        )
        default_target = self.effective_default_target_folder_id()
        bare_gate = gate_bare_chat_requires_target(
            session_folder_id=self._folder_id,
            tasks_raw=tasks_for_gate,
            default_target_folder_id=default_target,
        )
        if bare_gate:
            logger.info(
                "delegate.bare_chat_no_target_rejected",
                session_folder_id=self._folder_id,
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=bare_gate,
                contract_failure=True,
            )
        if (
            not self._folder_id
            and default_target
            and not getattr(self, "_default_target_folder_id", None)
        ):
            # 观测：本批靠回合 hint 过闸（模型未显式 target_folder_id）
            logger.info(
                "delegate.turn_target_desk_inherited",
                folder_id=default_target,
            )

        # 跨回合同图追加：须在 build_run_plan 之前加载宿主计划，以便 depends_on 解析
        # 同 execution 已有图节点（对齐 build_added_nodes / replan add）。
        append_raw = arguments.get("append_to_execution_id")
        append_to = (
            append_raw.strip()
            if isinstance(append_raw, str) and append_raw.strip()
            else None
        )
        host_message_id: str | None = None
        append_seed: dict | None = None
        host_plan_for_append = None
        latest_miss_degraded_note: str | None = None
        if append_to and self._depth > 0:
            msg = (
                "append_to_execution_id 仅根协调者可用：嵌套 lead 不能跨回合追加协作图。"
                "请去掉该参数，直接在本子团队内委派。"
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=msg,
                contract_failure=True,
            )
        if append_to and append_to.lower() == "latest":
            from agentcore.runtime.coordination.session import active_coordination

            # 仅真同回合二次 delegate（message_id ≡ host_turn_id）才吞 latest。
            # 跨回合 adopt 后 eid 已是宿主、但 message_id≠host_turn_id → 须保留
            # append，走 graph_append + divert，让生长 run_plan 进宿主 journal。
            active = active_coordination(self._base_tool_context.execution_id)
            if (
                active is not None
                and active.active
                and _is_same_host_turn_append(active, self._message_id)
            ):
                append_to = None
            else:
                # 同回合第一波已收口：内存宿主优先于跨 message DB latest，禁静默挂旧图。
                last_eid = getattr(self, "_last_graph_execution_id", None)
                if (
                    self._calls >= 1
                    and isinstance(last_eid, str)
                    and last_eid.strip()
                ):
                    append_to = last_eid.strip()
                    last_plan = getattr(self, "_last_graph_plan", None)
                    if last_plan is not None:
                        host_plan_for_append = last_plan
                        last_seed = getattr(self, "_last_graph_seed", None)
                        if last_seed is not None and append_seed is None:
                            append_seed = last_seed
                    logger.info(
                        "delegate.graph_append_latest",
                        conversation_id=self._conversation_id or "",
                        resolved=append_to,
                        prefer_message_id=self._message_id,
                        exclude_message_id=None,
                        via="same_turn_memory",
                    )
                else:
                    from agentcore.runtime.delegate.graph_append import (
                        resolve_latest_appendable_execution,
                    )

                    resolved = await resolve_latest_appendable_execution(
                        conversation_id=self._conversation_id or "",
                        prefer_message_id=self._message_id,
                    )
                    if not resolved:
                        # 无图可追加：自动降级为不带 append 新建（勿 success=False 空转）。
                        latest_miss_degraded_note = (
                            '【latest 未命中·已自动新建】append_to_execution_id="latest" '
                            "未解析到可追加协作图（旧图已收口或本对话尚无图）；"
                            "已自动不带 append 新开团队。"
                            "向用户如实告知：本次是新组建团队、未在旧图上追加。"
                        )
                        append_to = None
                    else:
                        append_to = resolved
        # 同回合显式 append_to 命中当前活跃协作图 ≡ 不传 append（与 latest 软化对齐）。
        # 跨回合 adopt 后同 eid 仍须走跨图 load；活跃图 A + append_to=B（B≠A）禁误吞。
        if append_to:
            from agentcore.runtime.coordination.session import active_coordination

            active = active_coordination(self._base_tool_context.execution_id)
            if (
                active is not None
                and active.active
                and append_to == active.execution_id
                and _is_same_host_turn_append(active, self._message_id)
            ):
                append_to = None

        # 同回合注入 existing_plan：append 已加载则保持；否则活跃 live_plan；
        # 再否则本 tool 实例二次+ 自动合入上一张图（与显式 append 同路径）。
        # 跨回合无 append 仍默认新图——仅同回合（活跃 session / _calls≥1）自动合入。
        if host_plan_for_append is None and not append_to:
            from agentcore.runtime.coordination.session import active_coordination

            active = active_coordination(self._base_tool_context.execution_id)
            if (
                active is not None
                and active.active
                and getattr(active, "live_plan", None) is not None
                and (
                    _is_same_host_turn_append(active, self._message_id)
                    or self._calls >= 1
                )
            ):
                host_plan_for_append = active.live_plan
            elif self._calls >= 1:
                last_eid = getattr(self, "_last_graph_execution_id", None)
                last_plan = getattr(self, "_last_graph_plan", None)
                if isinstance(last_eid, str) and last_eid.strip():
                    append_to = last_eid.strip()
                    # 同回合内存宿主：无 journal 亦可合入（阻塞单人跑完常见）。
                    if last_plan is not None:
                        host_plan_for_append = last_plan
                        last_seed = getattr(self, "_last_graph_seed", None)
                        if last_seed is not None and append_seed is None:
                            append_seed = last_seed

        # 跨回合 append：新建节点 parent + merge run_plan 均绑宿主幕级 captain；
        # 解析不到 parent 回落本回合 _captain_run_id，merge 则不注入本回合 captain 卡。
        host_captain_run_id: str | None = None
        if append_to:
            from agentcore.runtime.delegate.graph_append import (
                load_host_journal_entries,
                load_host_plan_and_completed,
                parse_host_captain_run_id,
                resolve_host_message_id,
            )

            memory_host = host_plan_for_append is not None
            host_message_id = await resolve_host_message_id(
                conversation_id=self._conversation_id or "",
                execution_id=append_to,
            )
            if not host_message_id and not memory_host:
                msg = (
                    f"找不到 execution_id=`{append_to}` 对应的既有协作图。"
                    "请确认 id 来自本对话上一张团队执行的 run_plan，或改为不传 "
                    "append_to_execution_id 以新建图。"
                )
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )
            if host_message_id:
                loaded_plan, loaded_seed = await load_host_plan_and_completed(
                    host_message_id
                )
                if loaded_plan is not None:
                    host_plan_for_append = loaded_plan
                    append_seed = loaded_seed
                elif not memory_host:
                    msg = (
                        f"既有协作图 `{append_to}` 缺少可合并的计划快照（plan_snapshot），"
                        "无法跨回合追加。请新建团队执行。"
                    )
                    return ToolResult(
                        tool_call_id="",
                        success=False,
                        output="",
                        error=msg,
                        contract_failure=True,
                    )
                host_captain_run_id = parse_host_captain_run_id(
                    await load_host_journal_entries(host_message_id)
                )
            if host_plan_for_append is not None and getattr(
                host_plan_for_append, "topology_lock", False
            ):
                msg = (
                    "当前协作图处于工作流拓扑锁：禁止追加步骤。"
                    "可用 replan(steers=…) 改未跑步骤说明，或 stop 收口。"
                )
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )
            if host_plan_for_append is None:
                msg = (
                    f"既有协作图 `{append_to}` 缺少可合并的计划快照（plan_snapshot），"
                    "无法跨回合追加。请新建团队执行。"
                )
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )

        self._calls += 1
        # 冻结本次委派调用的序号：同回合并发的多个 delegate 调用共享 self._calls，若在完成侧
        # 惰性读取会把每个批次的 completed / synthesis 日志都错记到「最后自增到的序号」。这里
        # 立刻定格，透传给 drive → format_for_ceo 用于完成侧日志。
        call_idx = self._calls
        prefix = f"del_{new_id()}"
        # 约定文档目录默认：repair_code 不套 RESEARCH_DIR（S3：不再绑 criteria kind）。
        playbook_early = arguments.get("playbook")
        skip_dossier_default = (
            isinstance(playbook_early, str) and playbook_early.strip() == "repair_code"
        )
        if getattr(self, "_inherit_code_audit_discipline", False) and isinstance(
            tasks_raw, list
        ):
            from agentcore.runtime.runs.playbooks.audit import (
                apply_inherited_code_audit_discipline,
            )

            tasks_raw = apply_inherited_code_audit_discipline(tasks_raw)
            logger.info(
                "delegate.nested_code_audit_discipline",
                tasks=len(tasks_raw),
                depth=self._depth,
            )
        if isinstance(tasks_raw, list) and tasks_raw:
            from agentcore.runtime.delegate.task_models import (
                ensure_delegate_route_extras,
                inherit_model_from_tool,
                prepare_task_model_fields,
            )

            model_errors, model_idents = await prepare_task_model_fields(
                tasks_raw,
                user_id=getattr(self._base_tool_context, "user_id", "") or "",
                where_prefix="tasks",
                inherit_model=lambda rid: inherit_model_from_tool(self, rid),
            )
            if model_errors:
                msg = "委派任务无效：" + "；".join(model_errors)
                logger.info("delegate.rejected", errors=model_errors, reason="task_model")
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )
            await ensure_delegate_route_extras(
                self._llm,
                model_idents,
                user_id=getattr(self._base_tool_context, "user_id", "") or "",
            )
        plan, errors = build_run_plan(
            tasks_raw,
            valid_tools=valid_tools,
            id_prefix=prefix,
            parent_run_id=host_captain_run_id or self._captain_run_id,
            depth=self._depth + 1,
            complexity_hint=complexity_hint,
            existing_plan=host_plan_for_append,
            code_verified=skip_dossier_default,
            default_target_folder_id=self.effective_default_target_folder_id(),
        )
        if errors:
            msg = "委派任务无效：" + "；".join(errors)
            logger.info("delegate.rejected", errors=errors)
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=msg,
                # 参数/依赖校验打回是零成本可自纠——勿进熔断。
                contract_failure=True,
            )
        if getattr(self, "_topology_lock", False):
            plan.topology_lock = True
            wid = getattr(self, "_workflow_id", None)
            if isinstance(wid, str) and wid.strip():
                plan.workflow_id = wid.strip()
            wv = getattr(self, "_workflow_version", None)
            if isinstance(wv, int):
                plan.workflow_version = wv
        # 部分并行：检查点波后线性链可按 parallelism 放宽（默认 conservative 不改图）。
        from agentcore.runtime.delegate.parallelism import (
            resolve_parallelism,
            widen_post_checkpoint_deps,
        )

        parallelism = resolve_parallelism(
            arguments.get("parallelism"),
            complexity_hint=complexity_hint if isinstance(complexity_hint, str) else "standard",
            node_count=len(plan.nodes),
            has_checkpoint=any(n.checkpoint_after for n in plan.nodes),
        )
        widen_post_checkpoint_deps(plan, parallelism)
        from agentcore.runtime.delegate.continuation import apply_continuation_tool_merges
        from agentcore.runtime.runs.research_quality import (
            batch_declares_review_files,
        )

        # 真纯丙：续派 tools 声明已忽略；merge 保留兼容旧 session 字段（执行层不收窄）。
        await apply_continuation_tool_merges(plan, self)

        batch_includes_review = (
            playbook == "research_report" or batch_declares_review_files(tasks_raw)
        )
        # 成篇硬门只认 playbook==research_report（及既有非字数结构腿由 includes_review 覆盖）。
        batch_audit_hard = playbook == "research_report"
        from agentcore.runtime.delegate.completion import (
            execution_capability_warning,
            validate_cold_start_explore_deliverables,
            validate_repair_how_fixed,
        )

        # S3: completion_criteria kind 已删；忽略 CEO 误传的遗留字段。
        if "completion_criteria" in arguments:
            logger.info(
                "delegate.completion_criteria_ignored",
                reason="s3_kind_retired",
            )

        playbook_name_early = (
            playbook.strip() if isinstance(playbook, str) and playbook.strip() else None
        )
        how_fixed_err = validate_repair_how_fixed(
            playbook=playbook_name_early,
            playbook_args=arguments.get("playbook_args"),
        )
        if how_fixed_err:
            logger.info(
                "delegate.rejected",
                errors=[how_fixed_err],
                reason="repair_how_fixed",
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=how_fixed_err,
                contract_failure=True,
            )

        # 冷启动探索未完成：探路队须 ≥2 worker（S3：不再有 code_verified 例外）。
        explore_pending = bool(self._base_tool_context.cold_start_explore_pending)
        if explore_pending:
            explore_form_err = validate_cold_start_explore_deliverables(plan)
            if explore_form_err:
                logger.info(
                    "delegate.cold_start_explore_rejected",
                    reason="thin_team",
                )
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=explore_form_err,
                    contract_failure=True,
                )

        capability_warning = execution_capability_warning(
            plan,
            self._base_tool_context.backend,
            self._permission_axes,
        )
        if capability_warning:
            logger.info(
                "delegate.capability_warning",
                backend_location=getattr(self._base_tool_context.backend, "location", None),
            )
        # execution_id when already known at kickoff (append host / same-turn graph)
        kickoff_execution_id = append_to or self._base_tool_context.execution_id
        logger.info(
            "delegate.acceptance_resolved",
            criteria=None,
            source=None,
            **(
                {"execution_id": kickoff_execution_id}
                if kickoff_execution_id
                else {}
            ),
        )
        if self._depth >= 1:
            self._sub_workers_spawned += len(plan.nodes)

        from agentcore.runtime.delegate.seed_notes import (
            parse_seed_notes,
            parse_team_brief,
            resolve_coordination,
        )

        seed_notes, seed_err = parse_seed_notes(arguments.get("seed_notes"))
        if seed_err:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=seed_err,
                contract_failure=True,
            )
        brief_raw = arguments.get("team_brief")
        if brief_raw is not None:
            brief, brief_err = parse_team_brief(brief_raw)
            if brief_err:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=brief_err,
                    contract_failure=True,
                )
            self._team_brief = brief

        playbook_name = playbook.strip() if isinstance(playbook, str) and playbook.strip() else None
        coordination = resolve_coordination(
            raw=arguments.get("coordination") if "coordination" in arguments else None,
            complexity_hint=complexity_hint,
            seed_notes=seed_notes,
            team_brief=self._team_brief,
            playbook=playbook_name,
        )
        self._coordination = coordination
        self._seed_notes = seed_notes

        # 跨回合同图追加：先对「仅新批次」入闸（用宿主 journal completed），再合并进旧图。
        # 禁止先 merge 再 sibling 整图——会把已完成同座+同路径误判成同批交叉。
        added_nodes_for_anchor: list = list(plan.nodes)
        graph_redirect = None
        graph_redirect_token = None

        finalize_flag = bool(arguments.get("finalize"))
        from agentcore.runtime.coordination.host import (
            admit_before_run_plan_emit,
            should_defer_run_plan_emit_to_merge,
        )

        if append_to:
            from agentcore.runtime.coordination.session import current_execution_id
            from agentcore.runtime.runs.plan import RunPlanError

            # Workers / registry must see host eid before admit / emit.
            self._base_tool_context.execution_id = append_to
            # Turn teardown clears via current_execution_id — keep it on the host
            # so the append coordination session is not orphaned under a fresh id.
            current_execution_id.set(append_to)

            admitted_reject = admit_before_run_plan_emit(
                self,
                plan,
                execution_id=append_to,
                finalize=finalize_flag,
                call_idx=call_idx,
                host_plan=host_plan_for_append,
                seed_completed=append_seed,
            )
            if admitted_reject is not None:
                return admitted_reject

            old_plan = host_plan_for_append
            assert old_plan is not None  # loaded before build_run_plan
            added_nodes_for_anchor = []
            for node in plan.nodes:
                try:
                    old_plan.add(node)
                    added_nodes_for_anchor.append(node)
                except RunPlanError as exc:
                    logger.warning(
                        "delegate.graph_append_skip_node",
                        execution_id=append_to,
                        run_id=node.run_id,
                        error=str(exc),
                    )
            if not added_nodes_for_anchor:
                msg = "跨回合追加未并入任何新节点（可能与旧图 run_id 冲突）。请调整 tasks。"
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=msg,
                    contract_failure=True,
                )
            plan = old_plan
            execution_id = append_to
        else:
            execution_id = self._base_tool_context.execution_id or new_id()
            # 准入→提交→执行：sibling / 追加重叠 / 同构闸在 durable run_plan 之前。
            admitted_reject = admit_before_run_plan_emit(
                self,
                plan,
                execution_id=execution_id,
                finalize=finalize_flag,
                call_idx=call_idx,
            )
            if admitted_reject is not None:
                return admitted_reject

        if append_to and host_message_id:
            # 有宿主 journal 才 divert；同回合内存宿主（无 journal）只合入 plan / eid。
            from agentcore.core.log_context import get_log_value
            from agentcore.runtime.delegate.graph_append import (
                GraphAppendRedirect,
                bind_redirect,
                open_host_journal_writer,
            )
            from agentcore.runtime.events import graph_append as graph_append_event

            host_writer = await open_host_journal_writer(
                host_message_id=host_message_id,
                conversation_id=self._conversation_id or "",
                trace_id=get_log_value("trace_id"),
            )
            graph_redirect = GraphAppendRedirect(
                execution_id=append_to,
                host_message_id=host_message_id,
                append_message_id=self._message_id or "",
                host_writer=host_writer,
            )
            graph_redirect_token = bind_redirect(graph_redirect)
            roles_anchor = [
                n.role or n.agent_name or n.run_id for n in added_nodes_for_anchor
            ]
            self._sink.emit(
                graph_append_event(
                    execution_id=append_to,
                    host_message_id=host_message_id,
                    append_message_id=self._message_id or "",
                    added_count=len(added_nodes_for_anchor),
                    roles=roles_anchor,
                    added_run_ids=[n.run_id for n in added_nodes_for_anchor],
                    # 批 A1：跨回合追加暂归宿主既有幕（act-1）；开新幕是后续批次。
                    act_id="act-1",
                    act_kind="multi_agent",
                )
            )
            logger.info(
                "delegate.graph_append",
                execution_id=append_to,
                host_message_id=host_message_id,
                added=len(added_nodes_for_anchor),
                total=len(plan.nodes),
            )
        elif append_to:
            logger.info(
                "delegate.same_turn_memory_append",
                execution_id=append_to,
                added=len(added_nodes_for_anchor),
                total=len(plan.nodes),
            )

        record_plan_snapshot(plan)

        from agentcore.runtime.audit.hooks import on_delegate_plan

        on_delegate_plan(
            execution_id=execution_id,
            plan=plan,
            captain_run_id=self._captain_run_id,
        )
        # 同回合合入活跃协调时由 merge 在准入后发出成长后的 run_plan（提交点）。
        if not should_defer_run_plan_emit_to_merge(
            self, execution_id=execution_id, finalize=finalize_flag
        ):
            self._sink.emit(
                plan_event(
                    self,
                    execution_id,
                    plan,
                    host_message_id=host_message_id,
                    host_captain_run_id=host_captain_run_id,
                )
            )
        # 决策可观测: who + what got delegated (the「派了谁、干什么」input basis), not just a
        # node count. `parallel` = first-wave width (nodes with no deps → run concurrently), so
        # 扇出 vs 串行 is visible offline. `agents` is capped to keep the line bounded on a big fan-out.
        logger.info(
            "delegate.started",
            nodes=len(plan.nodes),
            call=call_idx,
            parallel=sum(1 for n in plan.nodes if not n.depends_on),
            complexity_hint=complexity_hint,
            coordination=coordination,
            append_to=append_to,
            plan=[
                {"id": n.run_id, "role": n.role, "depends_on": n.depends_on}
                for n in plan.nodes
            ],
            waves=_waves_ids_for_log(
                plan,
                host_for_cross_batch=(
                    host_plan_for_append
                    if host_plan_for_append is not None and not append_to
                    else None
                ),
            ),
            agents=[
                f"{n.role or n.agent_name or n.run_id}: {clip_preview(n.task, 80)}"
                for n in plan.nodes[:_DELEGATE_LOG_AGENTS_CAP]
            ],
        )
        # Plan-only eval: real plan path done (build + validate + run_plan). Skip drive
        # so workers / coordination never start; HANDOFF ends the CEO loop immediately.
        from agentcore.runtime.plan_only import is_plan_only

        if is_plan_only():
            # S3: no acceptance_echo (completion_criteria retired).
            summary = f"[plan-only] 已记录计划（{len(plan.nodes)} 节点），跳过执行。"
            if playbook_notes:
                summary = summary + "\n\n" + "\n\n".join(playbook_notes)
            logger.info("delegate.plan_only", nodes=len(plan.nodes), call=call_idx)
            from agentcore.runtime.delegate.batch_shape import annotate_batch_meta

            if graph_redirect_token is not None:
                from agentcore.runtime.delegate.graph_append import reset_redirect

                reset_redirect(graph_redirect_token)
            return annotate_batch_meta(
                ToolResult(
                    tool_call_id="",
                    success=True,
                    output=summary,
                    effect=ToolEffect.HANDOFF,
                    final_text=summary,
                ),
                node_count=len(added_nodes_for_anchor),
                has_deps=any(n.depends_on for n in added_nodes_for_anchor),
                playbook=playbook_name,
                audit_hard=batch_audit_hard,
                includes_review=batch_includes_review,
            )
        from agentcore.runtime.delegate.batch_shape import annotate_batch_meta

        # Cross-turn append seeds from host journal; fresh graphs start without seed.
        seed_completed = append_seed if append_to else None

        try:
            result = await drive(
                self,
                plan,
                execution_id=execution_id,
                seed_completed=seed_completed,
                finalize=bool(arguments.get("finalize")),
                seed_notes=seed_notes,
                complexity_hint=complexity_hint,
                coordination=coordination,
                call_idx=call_idx,
                # Omit → True（默认协调）；显式 false → 经典阻塞。勿用 bool(get())，
                # 否则缺省会落成 False，与 schema default 不一致。
                coordinate=(
                    bool(arguments["coordinate"])
                    if "coordinate" in arguments
                    else True
                ),
            )
        finally:
            if graph_redirect_token is not None:
                from agentcore.runtime.delegate.graph_append import reset_redirect

                reset_redirect(graph_redirect_token)
            if graph_redirect is not None:
                with contextlib.suppress(Exception):
                    await graph_redirect.host_writer.flush()

        # Soft warnings：挂在委派结果尾部，CEO 当轮可见。
        # SUSPEND（开工卡挂起）无 output 可挂，跳过——不改挂起语义。
        if result.output and result.effect is ToolEffect.CONTINUE:
            tails: list[str] = []
            if capability_warning:
                tails.append(capability_warning)
            if presentation_format_warning:
                tails.append(presentation_format_warning)
            if automation_delivery_warning:
                tails.append(automation_delivery_warning)
            if playbook_notes:
                tails.extend(playbook_notes)
            if latest_miss_degraded_note:
                tails.append(latest_miss_degraded_note)
            if consumer_deps_warn:
                tails.append(consumer_deps_warn)
            if design_impl_warn:
                tails.append(design_impl_warn)
            if root_slice_warn:
                tails.append(root_slice_warn)
            if append_to:
                # 口径与产品呈现一致：UI 在追加回合只显示「已往上方协作图追加 N 名成员」
                # 锚点，生长发生在上方旧图。回显 execution_id 供后续追加显式指定。
                tails.append(
                    f"【跨回合同图追加】已往上方协作图追加 "
                    f"{len(added_nodes_for_anchor)} 名成员（execution_id=`{append_to}`）；"
                    "生长呈现在上方旧图，本回合只显示追加锚点；队员正在后台报到，"
                    "完成态靠图事件异步呈现，勿宣称已全员就位；图完成态由该 execution 自身收口，"
                    "不随本回合 message_end 结束。向用户汇报请用「已追加、正在报到」口径；"
                    "用户要立等结果时用 finalize 阻塞收口。不要说成新组建团队。"
                )
            elif self._depth == 0:
                # 回显本图 execution_id（跨回合追加的显式指定通道；latest 解析为主路径）。
                # 仅根协调者——嵌套 lead 不能跨回合追加，回显只会误导。
                tails.append(
                    f"【协作图】本次团队执行 execution_id=`{execution_id}`"
                    '（跨回合往这张图追加队员：delegate 传 append_to_execution_id="latest" '
                    "或此精确 id；未命中可追加图时引擎自动新建并写明）。"
                )
            result.output = f"{result.output}\n\n" + "\n\n".join(tails)
        if result.success and execution_id:
            self._last_graph_execution_id = execution_id
            # 同回合二次合入：保留本图节点快照（journal 未命中时仍可作 existing_plan）。
            from agentcore.runtime.runs.plan import RunPlan as _RunPlan
            from agentcore.runtime.runs.types import RunPhase
            from agentcore.runtime.runs.types import RunState as _RunState

            self._last_graph_plan = _RunPlan(
                nodes=list(plan.nodes),
                origin=plan.origin,
            )
            # 阻塞跑完才记 completed seed；协调 kickoff 时队员未完成，勿伪造成完成。
            # 勿仅看 coordinate 入参：默认 true 时 solo 仍走阻塞臂，须记 seed，否则同回合
            # 二次合入会把已完成节点当成未完成 → 误判同构 / 重跑。
            from agentcore.runtime.coordination.session import active_coordination

            active = active_coordination(execution_id)
            if active is None or not active.active:
                self._last_graph_seed = {
                    n.run_id: _RunState(phase=RunPhase.COMPLETED, content="")
                    for n in plan.nodes
                }
        return annotate_batch_meta(
            result,
            node_count=len(added_nodes_for_anchor),
            has_deps=any(n.depends_on for n in added_nodes_for_anchor),
            playbook=playbook if isinstance(playbook, str) else None,
            audit_hard=batch_audit_hard,
            includes_review=batch_includes_review,
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
            coordination=self._coordination,
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
        coordinate: bool = False,
        apply_kickoff_grant: bool = False,
        coordination: str | None = None,
        team_brief: str | None = None,
        seed_notes: list[dict[str, str]] | None = None,
        ceo_review: dict | None = None,
    ) -> ToolResult:
        # 耐久恢复的批次协作参数回灌：挂起帧带回 coordination / team_brief / seed_notes
        # （挂起点在 setup_note_wall 之前，这批参数只活在工具实例上；恢复走全新实例，
        # 不回灌则 wall 批降级 none → worker 被剥便签三件套）。缺省 None = 在进程内
        # 热续跑，沿用实例现值。
        if coordination in ("wall", "none"):
            self._coordination = coordination
        if team_brief:
            self._team_brief = team_brief
        if seed_notes:
            self._seed_notes = list(seed_notes)
        if decision is CheckpointDecision.STOP:
            # team_preview STOP → soft guidance; plan_review STOP keeps format_for_ceo.
            return await finalize_stopped(
                self,
                plan,
                seed_completed,
                kickoff_cancelled=apply_kickoff_grant,
                note=note,
            )

        # Steer: ADJUST always; kickoff CONTINUE+note ≡ former adjust (嘱咐注入未跑队员).
        # plan_review CONTINUE+note does not steer (apply_kickoff_grant=False; UI still has 调整).
        if note.strip() and (
            decision is CheckpointDecision.ADJUST
            or (decision is CheckpointDecision.CONTINUE and apply_kickoff_grant)
        ):
            apply_steer(plan, seed_completed, checkpoint_run_ids, note.strip())
        # plan_review CONTINUE：读帧上 llm ceo_review → 压缩 REPLACE 注入 gate_notes。
        # 开工卡路径 (apply_kickoff_grant) 不走；deterministic / 无 review → 不下发。
        if (
            decision is CheckpointDecision.CONTINUE
            and not apply_kickoff_grant
            and ceo_review is not None
        ):
            from agentcore.runtime.delegate.steer import (
                apply_gate_notes,
                compress_ceo_review_for_gate,
            )

            gate_body = compress_ceo_review_for_gate(ceo_review)
            if gate_body:
                apply_gate_notes(plan, seed_completed, checkpoint_run_ids, gate_body)
        # Kickoff (开工卡): continue / adjust / timeout → grant.
        # apply_kickoff_grant is True only when resuming a team_preview suspension.
        if (
            apply_kickoff_grant
            and self._approval_gate is not None
            and decision
            in (
                CheckpointDecision.CONTINUE,
                CheckpointDecision.ADJUST,
                CheckpointDecision.TIMEOUT,
            )
        ):
            self._approval_gate.grant_delegation(execution_id)
        # Resume never re-runs the original execute() path, so re-emit run_plan here:
        # FE Option A keeps the same pause bubble + projection key on message_start
        # (reuses the existing assistant; never delete+create) — re-bind the DAG under
        # that same key before worker frames arrive.
        self._sink.emit(plan_event(self, execution_id, plan))
        logger.info(
            "delegate.resume_plan",
            execution_id=execution_id,
            decision=decision.value,
            nodes=len(plan.nodes),
        )
        # plan_review：仅经典路径 durable 挂起（协调态波边界只发 BOUNDARY_YIELD），续跑保持
        # coordinate=False。team_preview：挂在 coordinate fork **之前**，开做后续跑须默认
        # 臂后台（coordinate=True）；显式经典由调用方传 coordinate=False。
        from agentcore.runtime.delegate.batch_shape import annotate_batch_meta

        result = await drive(
            self,
            plan,
            execution_id=execution_id,
            seed_completed=seed_completed,
            finalize=False,
            # 开工卡恢复补种 CEO 预贴便签（挂起时尚未上墙）；plan_review 恢复不带（已上墙）。
            seed_notes=list(seed_notes or []),
            coordination=self._coordination,
            coordinate=coordinate,
        )
        return annotate_batch_meta(
            result,
            node_count=len(plan.nodes),
            has_deps=any(n.depends_on for n in plan.nodes),
        )

    async def replan(self, arguments: dict[str, Any]) -> ToolResult:
        from agentcore.runtime.runs import BoundaryReason

        sup = self._supervised
        if sup is None:
            msg = (
                "当前没有待续跑的受监督计划。replan 仅在 delegate 让出边界（输出『计划已"
                "让出』）或部分队员失败/跳过后可用；要发起新任务请用 delegate。"
            )
            return ToolResult(tool_call_id="", success=False, output="", error=msg)

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
            return ToolResult(tool_call_id="", success=False, output="", error=msg)
        locked = bool(getattr(sup.plan, "topology_lock", False)) or bool(
            getattr(self, "_topology_lock", False)
        )
        if locked and adds:
            msg = (
                "当前为工作流拓扑锁：禁止 replan(add=…) 新增步骤；"
                "可用 steers 改未跑步骤说明，或 stop=true 收口。"
            )
            return ToolResult(tool_call_id="", success=False, output="", error=msg)
        if sup.reason is BoundaryReason.BIND and not stop and not binds:
            msg = (
                "replan 需要 binds 定稿至少一个『待定稿』步骤，或设 stop=true 收口"
                "（仅 steers / add 不能让待定稿步骤运行起来）。"
            )
            return ToolResult(tool_call_id="", success=False, output="", error=msg)

        # Snapshot the pre-add node ids so we can tell which nodes apply_replan appended
        # (it mutates the plan in place) — those drive the re-emitted run_plan below.
        ids_before = {n.run_id for n in sup.plan.nodes}
        errors = await apply_replan(self, sup.plan, sup.completed, binds, steers, adds)
        if errors:
            # Seat/artifact rejects share append's message family — surface verbatim.
            if len(errors) == 1 and str(errors[0]).startswith("【队员追加已拒绝"):
                logger.info("replan.rejected", errors=errors, via="seat_admit")
                from agentcore.core.types import ToolEffect

                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=str(errors[0]),
                    effect=ToolEffect.CONTINUE,
                    contract_failure=True,
                )
            msg = "replan 无效：" + "；".join(errors)
            logger.info("replan.rejected", errors=errors)
            return ToolResult(tool_call_id="", success=False, output="", error=msg)

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
            coordination=self._coordination,
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
