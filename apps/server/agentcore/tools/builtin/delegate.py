"""delegate: the CEO main-agent's single orchestration primitive (统一 Run 模型 阶段3).

Replaces ``assemble_team``'s「升级 → 外部 planner LLM」铰链 with **D1′**：the CEO
(the high-frequency chat agent) itself decides *when* and *at what granularity* to
delegate, by calling this tool with a ``tasks`` array of inline workers. The tool
builds a RunPlan from those tasks (single / parallel / DAG falls out of the
``depends_on`` edges), drives it through the one ``WaveScheduler`` + the host
AGENT executor, and returns every worker's product back to the CEO.

Crucially it is **non-terminal**（D3 / Option 1，已确认）：unlike the legacy handoff
tool, ``delegate`` does NOT stream a final answer — it hands the workers' results
back into the CEO's own ReAct loop, so the CEO writes a SHORT user-facing overview
in its own voice (决策①：每个 worker 的完整产出在前端单独展示，CEO 不复述全文) and
may delegate again, adaptively. Worker token usage is accumulated on the instance
(``self.usage``) so the pipeline can fold it into the turn totals — a non-terminal
tool's output is otherwise not metered by the loop.

已接入 ``pipeline`` 作为 CEO 的唯一编排原语，取代 ``assemble_team``。

→ 见设计: docs/03-AI核心/编排器与CEO主Agent.md §一（delegate 原语）
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, ToolEffect, new_id
from agentcore.llm.config import apply_overrides
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import (
    EventSink,
    content_delta,
    plan_review_required,
    plan_review_resolved,
    run_context,
    run_plan,
    run_progress,
)
from agentcore.runtime.interaction import InteractionKind
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.costing import RunCost
    from agentcore.runtime.ports import ClientRequestBridge
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.scheduler import BoundaryReason
    from agentcore.runtime.runs.types import RunSpec, RunState
    from agentcore.runtime.sessions import SessionSaver, SessionStore
    from agentcore.runtime.suspension import SuspensionDeleter, SuspensionSaver

logger = get_logger(__name__)

# The CEO's synthesis reads the aggregated worker products as this tool's output;
# raise the model-facing truncation budget well above the 4000 default so a
# multi-worker batch isn't clipped before the CEO can integrate it. ``_format_for_ceo``
# now does the STRUCTURED bounding (per-product fidelity + a shared prose budget,
# CEO 综述输入瘦身) so the aggregate fits comfortably under this; the cap stays only as
# a last-resort net (the old behaviour: a blunt head-chop that dropped late workers).
_DELEGATE_OUTPUT_LIMIT = 16000

# Per-step product excerpt cap in a plan_review card (结构化挂起 2a): enough for the
# user to recognise what just finished without shipping the whole product over SSE.
_PLAN_REVIEW_SUMMARY_CHARS = 280

# Tool-doc layer (提示词瘦身 §三去重)：only the delegate MECHANICS live here — what the
# tool does, how the tasks array maps to single/parallel/DAG, and that it is
# non-terminal. The routing JUDGMENT (何时委派 / 怎么扇出) is owned ONCE by the CEO core
# (prompt._CEO_CORE_HINT, always-on); the advanced knobs' HOW lives in the
# team_orchestration_advanced skill + each param's own description. This description
# therefore keeps only a TERSE one-line routing reminder + a pointer, instead of
# re-teaching the criterion the core already states every turn (was a ~2x duplication).
_DELEGATE_DESCRIPTION = (
    "把当前任务拆给一支由你（主 Agent）指挥的临时团队执行，并把各队员的产出返回给你。"
    "本工具非终结：产出回到你的循环，你据此写一段简短概览（不逐字复述，用户可在界面看"
    "各成员全文），必要时再次调用继续委派。\n"
    "粒度由你定：传入一个 tasks 数组（每个元素一个内联角色，role + task 必填）。无依赖且"
    "仅 1 个=单兵；无依赖多个=并行；任一任务声明 depends_on（引用其它任务的 id）=按依赖"
    "图分波执行，上游产出自动注入下游。\n"
    "简单问答 / 闲聊 / 检索自己答；交付物（要产出或改动产物的活——写 / 改文件、删除 / 移动、"
    "运行代码，这些工具只 worker 持有）才用本工具，哪怕只派一个。其余进阶档位（finalize / "
    "can_delegate / contract / 模型档位 / 流水线等）见对应参数说明与 "
    "consult_skill(team_orchestration_advanced)。"
)

_DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "description": "要委派的子任务列表（每个是一个内联角色 worker）。",
            "items": {
                "type": "object",
                "properties": {
                    "role": {
                        "type": "string",
                        "description": "worker 的角色名，如『研究员』『前端工程师』。",
                    },
                    "task": {
                        "type": "string",
                        "description": (
                            "交给该 worker 的子任务。worker 会另外收到「原始用户请求」，"
                            "但看不到完整对话历史、也看不到你的思考；因此这里要把完成该"
                            "任务所需、原始请求之外的上下文写全，做到自包含。"
                        ),
                    },
                    "objective": {
                        "type": "string",
                        "description": "可选：该角色的职责/目标，用于设定其系统提示。",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：允许该 worker 使用的工具名（取自可用工具）。",
                    },
                    "model_preference": {
                        "type": "string",
                        "enum": ["fast", "strong"],
                        "description": "可选：模型档位，默认 strong。",
                    },
                    "reasoning_effort": {
                        "type": "string",
                        "enum": ["high", "max"],
                        "description": "可选：极复杂子任务可设 max 解锁更深推理。",
                    },
                    "expected_output": {
                        "type": "string",
                        "description": "可选：期望产出的形态/要点。",
                    },
                    "stance": {
                        "type": "string",
                        "enum": ["pro", "con"],
                        "description": (
                            "可选：仅用于【辩论 / 交叉审查】这类对立任务——标记该 worker 的"
                            "立场（pro=正方/支持，con=反方/反对）。纯前端呈现信号、执行不受"
                            "影响（仍是普通并行）；前端据此把正反产出并排对比、并把回合标记为"
                            "「辩论」。普通的并行分工不要设。"
                        ),
                    },
                    "group": {
                        "type": "string",
                        "description": (
                            "可选：与 stance 搭配，给同一组对立任务一个共同标识，把正/反"
                            "配对（一次可有多组对比 / 多维审查）。只有一组时可省略。"
                        ),
                    },
                    "round": {
                        "type": "integer",
                        "description": (
                            "可选：仅用于【真·多轮辩论】——标记该 task 属于第几轮（从 1 起）。"
                            "配合跨轮 depends_on（第 k 轮的一方依赖第 k-1 轮对方的产出）让"
                            "交锋逐轮推进。纯前端呈现信号、执行不受影响；前端据此按轮次分层"
                            "展示。单轮辩论 / 普通分工不要设。"
                        ),
                    },
                    "id": {
                        "type": "string",
                        "description": "可选：DAG 模式下供 depends_on 引用的本任务标识。",
                    },
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：依赖的其它任务 id（出现任一即进入 DAG 模式）。",
                    },
                    "result_handling": {
                        "type": "string",
                        "enum": ["pass_through", "summarize"],
                        "description": "可选：该产出注入下游时是原样还是摘要，默认原样。",
                    },
                    "can_delegate": {
                        "type": "boolean",
                        "description": (
                            "可选：是否允许该 worker 自己再向下委派一层子团队（默认否）。"
                            "仅当这个子任务本身复杂到还需二次拆分时才开；最多再嵌套一层，"
                            "其子成员不能继续委派。简单子任务不要开。"
                        ),
                    },
                    "checkpoint_after": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。仅用于【同一次 delegate 的多步 DAG】：给某个"
                            "高危 / 不可逆 / 范围可能跑偏的中间步骤设 true，则该步完成后、其"
                            "下游步骤运行前会自动暂停，请用户过目当前进展并决定「继续 / 停止」。"
                            "克制使用——只在确实值得让用户在继续前把关的节点设；单步委派或"
                            "末步设了也不会触发（其后无下游可把关，那种情况改用 ask_user）。"
                        ),
                    },
                    "bind_after_deps": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。仅用于【同一次 delegate 的多步 DAG】里某个下游"
                            "步骤：当它该做什么必须看上游产出才能定（典型：先调研 A、再据 A 的"
                            "发现写 B，而 B 的具体职责取决于 A 查出什么），把该步设 true、其 "
                            "role / task 先写成占位即可；它的全部上游完成后、本步运行前，控制权"
                            "会交回你（delegate 输出『计划已让出』），你据上游产出用 replan 把它"
                            "定稿再续跑同一计划。克制使用——只在『此刻写死下游 spec 很可能跑偏』"
                            "时设；上游已定、下游 spec 现在就能写清的步骤不要设（徒增一次回合）。"
                        ),
                    },
                    "contract": {
                        "type": "object",
                        "description": (
                            "可选：对该 worker 产出的【验收底线】（事后机械校验，非事前结构蓝图）——"
                            "声明产出必须满足的硬性兜底（必含要点 / 篇幅 / 格式 / 落盘），确保不漏关键"
                            "项，不是用来替专家规定交付物的完整结构。不达标会带着具体差距自动返工一次；"
                            "返工后仍不达标时，默认仅附质检提醒（软），strict=true 则判该 worker 失败"
                            "（硬退）。"
                        ),
                        "properties": {
                            "required_sections": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": (
                                    "验收底线：产出必须覆盖的少数关键部分（按小标题校验是否在场），"
                                    "如『结论』『风险』。用于兜底「别漏掉关键内容」，不是用来替专家"
                                    "规定完整章节骨架——交付物的结构由 worker 设计。"
                                ),
                            },
                            "must_contain": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": (
                                    "验收底线：产出必须出现的关键词 / 内容（字面校验）；只兜关键点，"
                                    "不是用来规定结构。"
                                ),
                            },
                            "min_length": {
                                "type": "integer",
                                "description": "产出最少字数，低于则判未达标。",
                            },
                            "max_length": {
                                "type": "integer",
                                "description": "产出最多字数，超过则判未达标。",
                            },
                            "output_format": {
                                "type": "string",
                                "enum": ["text", "json"],
                                "description": "要求的产出格式；json 会校验能否解析。",
                            },
                            "requires_files": {
                                "type": "boolean",
                                "description": (
                                    "产出是落盘文件（可运行代码 / 网页 / 应用、脚本、配置、"
                                    "数据文件等用户要打开 / 运行 / 保存的东西）时设 true：未调用"
                                    " file_write 把产物写进工作区即判未达标、自动返工，杜绝把整份"
                                    "文件内容粘在回复正文、工作区却空着。纯文字交付（分析 / 说明 /"
                                    " 问答）不要设。"
                                ),
                            },
                            "strict": {
                                "type": "boolean",
                                "description": (
                                    "决定返工后仍不达标时的处置（返工一次与本字段无关、"
                                    "总会先发生）：true=判该 worker 失败（硬退）；"
                                    "false=仍接受产出、仅附质检提醒（软，默认）。"
                                ),
                            },
                        },
                    },
                },
                "required": ["role", "task"],
            },
        },
        "finalize": {
            "type": "boolean",
            "description": (
                "可选，默认 false。仅当本次只派【一个】worker、且这次委派就是整件事的"
                "最终交付（如建一个文件、改一行、产出一段可独立阅读的内容）时设 true："
                "该 worker 成功后，其产出会直接作为你的最终答复呈现给用户，你不必再写"
                "概览。只要你可能在看到结果后还要继续委派 / 补充，或本次派了多个 worker，"
                "就不要设——默认会把结果交回你来收尾；worker 失败时也会自动回落到由你收尾。"
            ),
        },
    },
    "required": ["tasks"],
}


@dataclass
class _SupervisedRun:
    """A delegate plan paused at a decision boundary, awaiting the CEO's ``replan`` (受监督
    的波循环). Holds exactly what :meth:`DelegateTool.replan` needs to finalise / re-steer
    and resume the SAME DAG from where it yielded: the (mutable) plan, the completed-so-far
    seeds, the turn's execution id, the original ``finalize`` flag, the ``reason`` it
    yielded for (``BIND`` = late-bind a placeholder, ``SCOPE`` = re-steer the tail after a
    队员 deviation — gates ``replan``'s required-field check), and the run_ids that triggered
    the yield (the late-bound node for BIND, the deviating node for SCOPE).
    """

    plan: RunPlan
    completed: dict[str, RunState]
    execution_id: str
    finalize: bool
    reason: BoundaryReason
    boundary_run_ids: list[str]


class DelegateTool:
    """CEO-agent tool that delegates sub-tasks to a Run plan and returns their
    products for the CEO to synthesize (non-terminal, Option 1)."""

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
        depth: int = 0,
    ) -> None:
        self._llm = llm
        self._sink = sink
        self._system_prompt = system_prompt
        self._user_message = user_message
        self._history = history
        self._tools = tools
        self._base_tool_context = base_tool_context
        # The turn's resolved 质量档 (llm/modes.py): which model each worker tier
        # runs this turn. Forwarded verbatim to a nested sub-team (_make_child) so
        # the whole tree honors the user's selection. None (standalone / tests) =
        # the economy base set.
        self._profile_set = profile_set or default_profile_set()
        self._max_parallel = max_parallel
        # The CEO's per-turn approval gate, forwarded to workers ONLY in local
        # mode (双模式工作区 P2d 执行门) so a delegated worker cannot run code or
        # mutate files on the user's real machine without consent; None in cloud
        # (workers stay un-gated — the server sandbox is isolated). See execute().
        self._approval_gate = approval_gate
        # The delegating CEO's synthetic root run id, so every member's ledger row
        # points its ``parent_run_id`` at the captain and the turn's run tree is
        # reconstructable. None when the tool runs standalone (e.g. tests).
        self._captain_run_id = captain_run_id
        # The turn's live roster (留人): after a batch finishes, each COMPLETED
        # worker is preserved here as a recoverable RunSession so the CEO can 定向
        # 唤回 (revise) the SAME author to continue on its own draft. None when the
        # tool runs standalone (e.g. tests) or 热修 is disabled.
        self._session_store = session_store
        # Optional write-through to the durable roster (P3 跨进程落盘): persists each
        # registered session so a 唤回 still hits after a restart / eviction. None ⇒
        # in-memory only (P2). Forwarded to nested sub-teams (_make_child).
        self._session_saver = session_saver
        # This captain's own depth in the turn's Run tree (CEO = 0). Workers this
        # tool spawns are minted at ``depth + 1``; a worker that itself re-delegates
        # gets a child tool seeded with its own depth (阶段2 嵌套子任务).
        self._depth = depth
        # 结构化挂起 2a: the unified interaction bridge + this turn's conversation +
        # the plan_review wait bound, used to suspend the WaveScheduler at a wave
        # boundary when a delegate step is marked ``checkpoint_after``.
        # ``checkpoint_enabled`` mirrors the ask_user gate (a live interactive user);
        # off ⇒ the marker stays inert (no ``on_boundary`` hook is handed to the
        # scheduler, so a marked plan runs straight through). Forwarded verbatim to
        # nested sub-teams (_make_child) so a sub-DAG's checkpoint also fires.
        self._conversation_id = conversation_id
        self._registry = registry
        self._checkpoint_timeout_seconds = checkpoint_timeout_seconds
        self._checkpoint_enabled = checkpoint_enabled
        # 结构化挂起 2b (turn 级落盘 + /resume): the turn's assistant ``message_id``
        # (the frame's key) + the persist / drop closures. When all are wired and this
        # is the TOP-LEVEL captain's delegate (``depth == 0``), a plan_review pause is
        # persisted to ``paused_turns`` BEFORE the wait and dropped after a live
        # in-process resolve — so a disconnect / restart during the pause leaves a
        # frame ``POST .../resume`` can rebuild. None / nested ⇒ 2a in-memory only.
        self._message_id = message_id
        self._suspension_saver = suspension_saver
        self._suspension_deleter = suspension_deleter
        # Child delegate tools minted for re-delegating workers this turn (one per
        # nesting worker). Their sub-team usage + cost rows are folded back into
        # this tool's totals after each call — see _absorb_children.
        self._children: list[DelegateTool] = []
        # How many times this tool was invoked this turn (an adaptive captain may
        # delegate repeatedly). Telemetry only — run-id uniqueness now rides a uuid
        # batch prefix (see execute), not this counter.
        self._calls = 0
        # This turn's「用量 + 账目 + 引用」roll-up, SHARED with revise via one
        # WorkerResultAccumulator (runtime/costing.py): worker token usage (cache
        # split kept, folded into the turn totals by the pipeline), one per-run cost
        # ledger row per metered worker (决策②), and the workers' de-duped web
        # sources (folded into the turn's shared source card; only COMPLETED runs
        # contribute). Exposed read-only as ``usage`` / ``run_ledger`` / ``citations``
        # (properties below) so the pipeline and tests read the same surface. Lazy
        # import keeps the tools package free of an import-time runtime.runs dep.
        from agentcore.runtime.costing import WorkerResultAccumulator

        self._acc = WorkerResultAccumulator()
        # 受监督的波循环 (P3): the plan currently paused at a decision boundary, awaiting the
        # CEO's ``replan`` to late-bind / re-steer and resume; None when no supervised plan
        # is open. Set by ``_drive`` on a YIELD, consumed by ``replan``.
        self._supervised: _SupervisedRun | None = None
        # The boundary the active scheduler run YIELDed on — ``(reason, nodes)`` set by the
        # boundary hook's BIND / SCOPE arm, read by ``_drive`` right after ``run()`` to stash
        # + brief. Reset at the start of every ``_drive`` so a stale signal never leaks.
        self._pending_boundary: tuple[BoundaryReason, list[RunSpec]] | None = None

    @property
    def usage(self) -> dict[str, int]:
        """This turn's accumulated worker token usage (the pipeline folds it in)."""
        return self._acc.usage

    @property
    def run_ledger(self) -> list[RunCost]:
        """One per-run cost row per metered worker this turn (决策②)."""
        return self._acc.run_ledger

    @property
    def citations(self) -> list[dict[str, Any]]:
        """The workers' de-duped web sources (folded into the turn's shared card)."""
        return self._acc.citations

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="delegate",
            description=_DELEGATE_DESCRIPTION,
            parameters=_DELEGATE_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        # Lazy import: keep the tools package free of an import-time dependency on
        # the runtime.runs package (which imports the engine, which imports this
        # registry) — avoids a circular import.
        from agentcore.runtime.runs import build_run_plan

        tasks_raw = arguments.get("tasks")
        if not isinstance(tasks_raw, list) or not tasks_raw:
            msg = "'tasks' 必须是非空数组：每个元素至少包含 role 和 task。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        valid_tools = {s.name for s in self._tools.list_all()}
        self._calls += 1
        # Globally-unique batch prefix. The old ``del{calls}_{ms}`` collided when a
        # parent and its nested child delegate — or two parallel re-delegating
        # workers — fired in the same millisecond, minting duplicate run ids across
        # the tree (a sub-worker reusing its captain worker's id). A uuid is
        # collision-free across every delegate tool/call in the turn; ``_calls``
        # stays for telemetry only.
        prefix = f"del_{new_id()}"
        # Stamp every worker with its place in the turn's Run tree: parented to this
        # captain, one level deeper than this tool (CEO=0 → workers depth 1; a
        # re-delegating worker's child tool → its sub-workers depth 2).
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

        # 执行级事件溯源 Phase 2 (frame.plan 退场): journal the full DAG (minted run_ids +
        # policy/contract) so a resume rebuilds the plan from facts (plan_from_journal),
        # not the旁路 frame. Recorded once at build; an ``adjust`` steer re-snapshots.
        self._record_plan_snapshot(plan)

        execution_id = self._base_tool_context.execution_id or new_id()
        self._sink.emit(self._plan_event(execution_id, plan))
        logger.info("delegate.started", nodes=len(plan.nodes), call=self._calls)
        return await self._drive(
            plan,
            execution_id=execution_id,
            seed_completed=None,
            finalize=bool(arguments.get("finalize")),
        )

    async def _drive(
        self,
        plan: RunPlan,
        *,
        execution_id: str,
        seed_completed: dict[str, RunState] | None,
        finalize: bool,
    ) -> ToolResult:
        """Run ``plan`` through the WaveScheduler and fold the workers' products into a
        CEO-facing ToolResult (shared by a fresh ``execute`` and a 2b ``resume_plan``).

        ``seed_completed`` pre-seeds finished nodes (a resume): they are treated as
        done, so only the unfinished tail runs; their usage/cost/citations still ride
        in ``results`` so the (resumed) turn bills the WHOLE plan once. A downstream
        ``checkpoint_after`` step still pauses via :meth:`_boundary_hook`, so a
        resume can itself re-pause (and re-persist) at a later checkpoint.
        """
        # 受监督的波循环 (P3): clear the per-run boundary signal — the on_boundary BIND / SCOPE
        # arm sets it when it YIELDs, and the block after ``run()`` reads it to stash + brief.
        self._pending_boundary = None
        from agentcore.runtime.costing import usage_metadata
        from agentcore.runtime.runs import (
            DEFAULT_MAX_PARALLEL,
            BatchMetrics,
            RunPhase,
            WaveScheduler,
            build_agent_executor,
        )

        # Gate workers' machine-touching tools ONLY when the workspace is local —
        # then a worker's code_execute / file_write runs on the user's real disk
        # and needs the same consent the CEO already gives. In cloud the backend is
        # an isolated server sandbox, so workers stay un-gated (unchanged behavior).
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
            # Lets a worker that opted in (can_delegate) lead one nested sub-team;
            # the executor enforces the depth cap, so this is inert below it.
            delegate_factory=self._make_child,
            # 阻塞式求决策: hand each worker the suspend-for-the-user channel for
            # escalate(blocking=true). Same bridge + window + gate as ask_user; armed
            # only when a live interactive user is present (``_checkpoint_active``), so an
            # autonomous / un-armed turn degrades a worker's blocking escalate to
            # non-blocking. A nested sub-team inherits this (``_make_child`` forwards the
            # registry / conversation / gate), so depth-2 reaches the user too (设计 §4.2).
            interaction_bridge=self._registry,
            escalation_timeout=self._checkpoint_timeout_seconds,
            escalation_armed=self._checkpoint_active(),
        )

        total = len(plan.nodes)

        def _progress(completed) -> None:
            done = sum(1 for s in completed.values() if s.phase is RunPhase.COMPLETED)
            self._sink.emit(run_progress(done, total))

        # 受监督的波循环: hand the scheduler the decision-boundary hook when ANY arm could
        # fire this run: the user CHECKPOINT arm is armed (live interactive user), the plan
        # has late-bound nodes (the CEO BIND arm, no user needed), OR the plan has a
        # dependency edge (the CEO SCOPE arm — a worker could escalate kind=scope and there
        # is un-run downstream to re-steer; a flat fan-out has no tail to redirect, so it
        # stays hookless = byte-for-byte unchanged). Off ⇒ None, so every marker stays inert
        # and the plan runs straight through. The hook being wired adds no CEO round on its
        # own: a run with no marker / no scope escalation never reaches a boundary.
        on_boundary = (
            self._boundary_hook(plan)
            if (
                self._checkpoint_active()
                or any(n.bind_after_deps for n in plan.nodes)
                or any(n.depends_on for n in plan.nodes)
            )
            else None
        )
        batch_metrics: list[BatchMetrics] = []
        results = await WaveScheduler(self._max_parallel or DEFAULT_MAX_PARALLEL).run(
            plan,
            executor,
            seed_completed=seed_completed,
            on_progress=_progress,
            on_boundary=on_boundary,
            metrics_sink=batch_metrics,
        )
        if batch_metrics:
            # 调度埋点量化: one batch-health line per delegate run — did parallelism
            # materialise (avg_parallelism = busy/wall) and was the width cap the
            # bottleneck (slot_starved > 0). Symmetric with delegate.started.
            m = batch_metrics[0]
            logger.info(
                "delegate.completed",
                call=self._calls,
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

        # 受监督的波循环 (P3): the scheduler YIELDed at a decision boundary (the boundary hook
        # set ``_pending_boundary`` — BIND for a late-bound node, SCOPE for a 队员 deviation).
        # Stash the partial run + hand a「计划已让出」brief back to the CEO's ReAct loop
        # (non-terminal) — it calls ``replan`` to finalise / re-steer and resume the SAME DAG.
        # Accumulation / roster registration are DEFERRED to the terminal ``_drive`` (the
        # resume bills seeds+tail once), so a multi-yield turn never double-bills. Edge: if the
        # turn ends without ever resuming to terminal, the pre-yield seeds go unbilled —
        # acceptable v1; P5 can finalise an open supervised run at turn end.
        if self._pending_boundary is not None:
            reason, nodes = self._pending_boundary
            self._pending_boundary = None
            self._supervised = _SupervisedRun(
                plan=plan,
                completed=dict(results),
                execution_id=execution_id,
                finalize=finalize,
                reason=reason,
                boundary_run_ids=[n.run_id for n in nodes],
            )
            logger.info(
                "delegate.yielded",
                call=self._calls,
                reason=reason.value,
                boundary=[n.run_id for n in nodes],
                completed=len(results),
            )
            return ToolResult(
                tool_call_id="",
                success=True,
                output=self._format_boundary_for_ceo(reason, plan, results, nodes),
                output_limit=_DELEGATE_OUTPUT_LIMIT,
            )

        call_usage = self._accumulate_usage(results)
        self._collect_ledger(plan, results)
        self._collect_citations(results)
        registered = self._register_sessions(plan, results)
        if self._session_saver is not None:
            for session in registered:
                await self._session_saver(session)
        self._absorb_children()

        # 提案2a 直出：CEO 显式 finalize 且本批只有一个 worker、且它成功产出时，把该
        # 产出直接作为本回合最终答复（HANDOFF 终态），省掉 CEO 再写一段概览的 LLM 轮次。
        # 其余情况（多 worker、单 worker 失败或空产出）一律回落到下面的非终态路径，由
        # CEO 照常收尾——这就是 finalize 的安全兜底。
        if finalize and len(plan.nodes) == 1:
            only = results.get(plan.nodes[0].run_id)
            if only and only.phase is RunPhase.COMPLETED and only.content.strip():
                return self._direct_result(only.content)

        output = self._format_for_ceo(plan, results)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            output_limit=_DELEGATE_OUTPUT_LIMIT,
            metadata=usage_metadata(call_usage),
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
        """Continue a paused plan from a resumed turn (结构化挂起 2b ``POST .../resume``).

        The plan + its finished nodes (``seed_completed``) were rebuilt from the
        durable frame; this applies the user's plan_review decision and drives the
        remaining tail, returning the same CEO-facing aggregate ``execute`` would:

        - ``STOP``: don't run the tail — materialise the unrun downstream as SKIPPED
          (the same shape 2a's stop produced), bill / register the seeds, and format,
          so the CEO writes an overview of the partial work.
        - ``ADJUST``: inject the user's note as a steer onto the reviewed checkpoint
          nodes' not-yet-run dependents, then drive (CONTINUE's path with redirection).
        - ``CONTINUE``: drive the tail as-is.

        The plan_event is NOT re-emitted (the graph was declared pre-pause and rides in
        the seeded journal); a downstream ``checkpoint_after`` can pause again via the
        normal hook (re-persisting a fresh frame).
        """
        if decision is CheckpointDecision.STOP:
            return await self._finalize_stopped(plan, seed_completed)

        if decision is CheckpointDecision.ADJUST and note.strip():
            self._apply_steer(plan, seed_completed, checkpoint_run_ids, note.strip())
        return await self._drive(
            plan, execution_id=execution_id, seed_completed=seed_completed, finalize=False
        )

    async def replan(self, arguments: dict[str, Any]) -> ToolResult:
        """Resume a delegate plan paused at a decision boundary (受监督的波循环 / replan).

        Called by the ``replan`` tool after a delegate「计划已让出」brief. At a BIND boundary
        it finalises the late-bound node(s) (``binds``); at a SCOPE boundary (a 队员 reported
        a 职责/范围 deviation) it re-steers the not-yet-run tail (``steers``). Both may also
        steer / bind, or wrap up (``stop``); then it resumes the SAME DAG from where it
        yielded. Non-terminal, like ``delegate``: returns the next boundary brief (a further
        YIELD) or the terminal team result, both handed back to the CEO loop.
        """
        from agentcore.runtime.runs import BoundaryReason

        sup = self._supervised
        if sup is None:
            msg = (
                "当前没有待续跑的受监督计划。replan 仅在 delegate 让出边界（输出『计划已"
                "让出』）后可用；要发起新任务请用 delegate。"
            )
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        binds = arguments.get("binds") or []
        steers = arguments.get("steers") or []
        stop = bool(arguments.get("stop"))
        if not isinstance(binds, list) or not isinstance(steers, list):
            msg = "replan 的 binds / steers 必须是数组。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        # A BIND boundary MUST finalise a late-bound step (or stop) to make progress —
        # steers alone can't make a『待定稿』step runnable. A SCOPE boundary (re-steer the
        # tail after a deviation) is satisfied by steers, binds, a bare resume (the CEO
        # judged no downstream change needed), or stop — so it has no required field.
        if sup.reason is BoundaryReason.BIND and not stop and not binds:
            msg = (
                "replan 需要 binds 定稿至少一个『待定稿』步骤，或设 stop=true 收口"
                "（仅 steers 不能让待定稿步骤运行起来）。"
            )
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        errors = self._apply_replan(sup.plan, sup.completed, binds, steers)
        if errors:
            msg = "replan 无效：" + "；".join(errors)
            logger.info("replan.rejected", errors=errors)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        # Consumed — a further YIELD on resume re-stashes a fresh supervised run.
        self._supervised = None
        # Re-snapshot the finalised DAG so a later durable pause's plan_from_journal
        # reflects the binds/steers (frame.plan 退场, same discipline as _apply_steer).
        self._record_plan_snapshot(sup.plan)
        logger.info("replan.applied", binds=len(binds), steers=len(steers), stop=stop)
        if stop:
            return await self._finalize_stopped(sup.plan, sup.completed)
        return await self._drive(
            sup.plan,
            execution_id=sup.execution_id,
            seed_completed=sup.completed,
            finalize=sup.finalize,
        )

    def _apply_replan(
        self,
        plan: RunPlan,
        completed: dict[str, RunState],
        binds: list,
        steers: list,
    ) -> list[str]:
        """Validate then apply a replan's binds + steers to the paused plan in place.

        A bind finalises a ``bind_after_deps`` placeholder (whitelisted fields; clears
        the marker so the node becomes dispatchable); a steer appends a note to a
        not-yet-run node's ``RunSpec.steer`` (same mechanism as a plan_review adjust).
        All-or-nothing: any error returns the list and mutates NOTHING, so the CEO can
        retry cleanly.
        """
        valid_tools = {s.name for s in self._tools.list_all()}
        errors: list[str] = []
        bind_ops: list[tuple[RunSpec, dict[str, Any]]] = []
        for i, b in enumerate(binds):
            if not isinstance(b, dict):
                errors.append(f"binds[{i}] 必须是对象")
                continue
            rid = str(b.get("run_id") or "").strip()
            node = plan.by_id(rid) if rid else None
            if node is None:
                errors.append(f"binds[{i}]: run_id `{rid}` 不在当前计划")
                continue
            if not node.bind_after_deps:
                errors.append(f"binds[{i}]: `{rid}` 不是待定稿（晚绑定）步骤")
                continue
            if rid in completed:
                errors.append(f"binds[{i}]: `{rid}` 已完成")
                continue
            role = b.get("role")
            task = b.get("task")
            final_role = role.strip() if isinstance(role, str) and role.strip() else node.role
            final_task = task.strip() if isinstance(task, str) and task.strip() else node.task
            if not final_role:
                errors.append(f"binds[{i}]: `{rid}` 定稿需要 role")
                continue
            if not final_task:
                errors.append(f"binds[{i}]: `{rid}` 定稿需要 task")
                continue
            fields: dict[str, Any] = {"role": final_role, "task": final_task}
            objective = b.get("objective")
            if isinstance(objective, str) and objective.strip():
                fields["objective"] = objective.strip()
            expected = b.get("expected_output")
            if isinstance(expected, str) and expected.strip():
                fields["expected_output"] = expected.strip()
            mp = b.get("model_preference")
            if mp in ("fast", "strong"):
                fields["model_preference"] = mp
            tools = b.get("tools")
            if isinstance(tools, list):
                named = [t for t in tools if isinstance(t, str) and t in valid_tools]
                fields["tools"] = named or None
            bind_ops.append((node, fields))

        steer_ops: list[tuple[RunSpec, str]] = []
        for i, s in enumerate(steers):
            if not isinstance(s, dict):
                errors.append(f"steers[{i}] 必须是对象")
                continue
            rid = str(s.get("run_id") or "").strip()
            note = str(s.get("note") or "").strip()
            node = plan.by_id(rid) if rid else None
            if node is None:
                errors.append(f"steers[{i}]: run_id `{rid}` 不在当前计划")
                continue
            if rid in completed:
                errors.append(f"steers[{i}]: `{rid}` 已完成，无法操舵")
                continue
            if not note:
                errors.append(f"steers[{i}]: 缺少 note")
                continue
            steer_ops.append((node, note))

        if errors:
            return errors
        for node, fields in bind_ops:
            for key, value in fields.items():
                setattr(node, key, value)
            node.bind_after_deps = False  # finalised → dispatchable
        for node, note in steer_ops:
            node.steer = f"{node.steer}\n- {note}" if node.steer else f"- {note}"
        return []

    async def _finalize_stopped(
        self, plan: RunPlan, seed_completed: dict[str, RunState]
    ) -> ToolResult:
        """Wrap up a partial plan without running the tail: materialise un-run nodes as
        SKIPPED, bill / register the seeds, and format the CEO overview. Shared by a
        user plan_review ``stop`` (resume_plan) and a supervised ``replan(stop=true)``.
        """
        from agentcore.runtime.runs import RunPhase, RunState

        results: dict[str, RunState] = dict(seed_completed)
        for node in plan.nodes:
            results.setdefault(node.run_id, RunState(phase=RunPhase.SKIPPED))
        self._accumulate_usage(results)
        self._collect_ledger(plan, results)
        self._collect_citations(results)
        registered = self._register_sessions(plan, results)
        if self._session_saver is not None:
            for session in registered:
                await self._session_saver(session)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=self._format_for_ceo(plan, results),
            output_limit=_DELEGATE_OUTPUT_LIMIT,
        )

    def _format_boundary_for_ceo(
        self,
        reason: BoundaryReason,
        plan: RunPlan,
        results: dict,
        nodes: list[RunSpec],
    ) -> str:
        """The CEO-facing「计划已让出」brief when a supervised plan YIELDs (受监督的波循环).

        Dispatches on the boundary reason: ``BIND`` shows each late-bound node's placeholder
        + its just-completed upstream products (so the CEO can bind from them); ``SCOPE``
        shows each deviating node's output + its scope escalation (so the CEO can re-steer
        the not-yet-run tail). Both end with a ``replan`` call-to-action.
        """
        from agentcore.runtime.runs import BoundaryReason

        if reason is BoundaryReason.SCOPE:
            return self._format_scope_boundary(plan, results, nodes)
        return self._format_bind_boundary(plan, results, nodes)

    def _format_bind_boundary(
        self, plan: RunPlan, results: dict, nodes: list[RunSpec]
    ) -> str:
        """BIND-arm brief (晚绑定): each late-bound node's placeholder + its upstream
        products, and the ``replan`` instruction to finalise (binds [+ steers]) or stop."""
        from agentcore.runtime.runs import RunPhase

        lines = [
            "## 计划已让出（请定稿待绑定步骤后续跑）",
            "下列步骤声明了「依赖完成后再定稿」(bind_after_deps)：其上游已就位，现在由你"
            "依据上游产出把它们的职责 / 任务定稿，然后用 `replan` 续跑同一计划。",
        ]
        for node in nodes:
            dep_lines: list[str] = []
            for dep_id in node.depends_on:
                state = results.get(dep_id)
                summary = (state.content if state else "") or ""
                if len(summary) > _PLAN_REVIEW_SUMMARY_CHARS:
                    summary = summary[:_PLAN_REVIEW_SUMMARY_CHARS] + "…"
                dep = plan.by_id(dep_id)
                dep_role = (dep.role if dep else dep_id) or dep_id
                dep_lines.append(f"  - 上游 `{dep_id}`（{dep_role}）：{summary or '（无产出）'}")
            lines.append(
                f"\n### 待定稿 · run_id: `{node.run_id}`"
                f"（占位角色：{node.role or '未填'}）\n"
                f"占位任务：{node.task or '（未填）'}\n"
                "依赖产出：\n" + ("\n".join(dep_lines) or "  - （无上游）")
            )
        pending = [n.run_id for n in plan.nodes if n.run_id not in results]
        done = sum(1 for s in results.values() if s and s.phase is RunPhase.COMPLETED)
        lines.append(
            "\n---\n请调用 `replan` 定稿上述步骤："
            "`binds=[{run_id, role, task, …}]`（定稿后该步即可运行）；可选 "
            "`steers=[{run_id, note}]` 操舵其它未跑步骤；确无需继续则 `replan(stop=true)`。\n"
            f"当前已完成 {done} 步；待跑：{('、'.join(f'`{p}`' for p in pending)) or '（无）'}。"
        )
        return "\n".join(lines)

    def _format_scope_boundary(
        self, plan: RunPlan, results: dict, nodes: list[RunSpec]
    ) -> str:
        """SCOPE-arm brief (偏离信号 / 自底向上反应臂): each deviating node's output + its
        scope escalation (question / assumption) and the not-yet-run tail, with a ``replan``
        instruction to re-steer the tail (steers [+ binds]), resume as-is, or stop."""
        from agentcore.runtime.runs import RunPhase

        lines = [
            "## 计划已让出（队员报告职责偏离，请校准未跑步骤）",
            "下列【已完成】步骤报告了「职责/范围偏离」(escalate kind=scope)：它们在执行中发现"
            "真正要做的与初始计划不符。请阅读它们的产出与偏离说明，判断是否需要操舵【尚未运行】"
            "的下游步骤，再用 `replan` 续跑同一计划。",
        ]
        for node in nodes:
            state = results.get(node.run_id)
            summary = (state.content if state else "") or ""
            if len(summary) > _PLAN_REVIEW_SUMMARY_CHARS:
                summary = summary[:_PLAN_REVIEW_SUMMARY_CHARS] + "…"
            esc_lines: list[str] = []
            for e in state.escalations if state else []:
                if e.get("kind") != "scope":
                    continue
                question = str(e.get("question") or "").strip()
                assumption = str(e.get("assumption") or "").strip()
                esc_lines.append(f"  - 偏离：{question or '（未写明）'}")
                if assumption:
                    esc_lines.append(f"    暂定假设：{assumption}")
            lines.append(
                f"\n### 偏离 · run_id: `{node.run_id}`（{node.role or node.run_id}）\n"
                f"产出：{summary or '（无产出）'}\n"
                "偏离说明：\n" + ("\n".join(esc_lines) or "  - （未写明）")
            )
        pending = [n.run_id for n in plan.nodes if n.run_id not in results]
        done = sum(1 for s in results.values() if s and s.phase is RunPhase.COMPLETED)
        lines.append(
            "\n---\n请调用 `replan` 校准未跑步骤：`steers=[{run_id, note}]` 操舵尚未运行的下游"
            "（运行前注入指令）；若某步是『待定稿』可一并 `binds=[…]` 定稿；确认无需改动可直接 "
            "`replan()` 续跑；确无需继续则 `replan(stop=true)`。\n"
            f"当前已完成 {done} 步；待跑：{('、'.join(f'`{p}`' for p in pending)) or '（无）'}。"
        )
        return "\n".join(lines)

    def _direct_result(self, content: str) -> ToolResult:
        """提案2a：把单个成功 worker 的产出直接作为本回合最终答复（HANDOFF 终态）。

        CEO 已就一个自包含的单一交付显式 finalize——于是把产出流式推到对话气泡
        （``content_delta``，因 ``final_text`` 只持久化、不会被引擎重发），并以
        ``ToolEffect.HANDOFF`` 结束回合，省掉一轮 CEO 合成。``metadata`` 不带 worker
        用量：它已记在 ``self.usage`` 上、由 pipeline 折算入回合总账；若再放进 metadata，
        引擎的终态分支会把它并入 captain 自身用量而造成双计。
        """
        self._sink.emit(content_delta(content))
        return ToolResult(
            tool_call_id="",
            success=True,
            output=content,
            output_limit=_DELEGATE_OUTPUT_LIMIT,
            effect=ToolEffect.HANDOFF,
            final_text=content,
        )

    def _make_child(self, captain_run_id: str, captain_depth: int) -> DelegateTool:
        """Mint a delegate tool for a worker that leads one nested sub-team (阶段2).

        Same wiring as this tool, re-pointed: the worker becomes the sub-team's
        captain (``captain_run_id`` parents the sub-workers' ledger rows) and
        ``captain_depth`` is the worker's own depth, so its sub-workers come out at
        ``depth + 1``. Tracked in ``self._children`` so :meth:`_absorb_children`
        folds the sub-team's usage + cost back into the turn totals.
        """
        child = DelegateTool(
            llm=self._llm,
            sink=self._sink,
            system_prompt=self._system_prompt,
            user_message=self._user_message,
            history=self._history,
            tools=self._tools,
            base_tool_context=self._base_tool_context,
            profile_set=self._profile_set,
            max_parallel=self._max_parallel,
            captain_run_id=captain_run_id,
            approval_gate=self._approval_gate,
            session_store=self._session_store,
            session_saver=self._session_saver,
            conversation_id=self._conversation_id,
            registry=self._registry,
            checkpoint_timeout_seconds=self._checkpoint_timeout_seconds,
            checkpoint_enabled=self._checkpoint_enabled,
            # Durable suspension is top-level only (depth 0): a nested sub-team's
            # checkpoint keeps 2a in-memory behaviour (no frame), since resuming a
            # pause buried in a worker's own sub-loop is out of scope for 2b v1.
            # message_id/savers intentionally NOT forwarded → child can't persist.
            depth=captain_depth,
        )
        self._children.append(child)
        return child

    def _absorb_children(self) -> None:
        """Fold every nested sub-team spawned this call into the turn totals.

        A worker that re-delegated ran its sub-team through a child tool (from
        :meth:`_make_child`); the child accumulated its sub-workers' token usage,
        per-run cost rows (parented to that worker), and web sources. Roll them up so
        the top-level tool the pipeline reads carries the WHOLE tree's usage + ledger
        + sources. Cleared after folding so an adaptive captain's next call can't
        double-count.
        """
        # Roll each child's whole accumulator (usage + ledger + de-duped sources)
        # up into this captain's — so a nested worker's research / spend is not lost
        # at the next level up.
        for child in self._children:
            self._acc.merge(child._acc)
        self._children.clear()

    def _checkpoint_active(self) -> bool:
        """Whether structured checkpoints fire this turn (结构化挂起 2a).

        True only when the gate is on AND the interaction bridge + conversation are
        wired — off / standalone / tests leave ``checkpoint_after`` inert.
        """
        return bool(
            self._checkpoint_enabled and self._registry and self._conversation_id
        )

    def _boundary_hook(self, plan: RunPlan):
        """Build the WaveScheduler ``on_boundary`` hook for ``plan`` (受监督的波循环).

        The single host-side boundary handler, switching on :class:`BoundaryReason`:
        ``BIND`` (晚绑定) and ``SCOPE`` (偏离信号 / 自底向上反应臂) both hand control back to
        the CEO — record the node(s) + ``YIELD``, so ``_drive`` briefs the CEO (a bind brief
        vs a deviation brief, by reason) and stashes for ``replan``; ``CHECKPOINT`` (结构化挂
        起 2a/2b) is the user plan_review below (soft-inert = proceed when the user channel
        isn't armed this turn, e.g. a BIND/SCOPE-only wiring).

        CHECKPOINT replays the ask_user suspend-resume shape at a wave boundary:
        register a plan_review on the interaction bridge, emit the request card, await
        the user's answer (timeout → continue — a soft checkpoint never silently halts),
        discard, emit the resolution. Maps the decision to a :class:`BoundaryOutcome`:
        ``STOP`` → ``ABORT`` (un-run tail materialised SKIPPED), else ``PROCEED``. An
        ``adjust`` proceeds too, but first injects the user's note as a steer onto the
        checkpoint's not-yet-run (transitive) dependents (:meth:`_apply_steer`) so the
        correction redirects exactly the work that builds on the reviewed output — not
        unrelated parallel branches. The scheduler stays pure; this host hook owns the
        round-trip + SSE + the steer.

        结构化挂起 2b: when this is the top-level captain's delegate and the persist
        closures are wired, a durable frame is saved to ``paused_turns`` BEFORE the
        wait and dropped AFTER a live resolve / timeout. A cancel (client disconnect)
        or a crash during the wait propagates past the drop, so the frame survives for
        ``POST .../resume`` to rebuild and continue the turn on a fresh process.
        """
        from agentcore.runtime.runs import BoundaryOutcome, BoundaryReason

        registry = self._registry
        conversation_id = self._conversation_id
        timeout = self._checkpoint_timeout_seconds

        async def on_boundary(reason, nodes, completed) -> BoundaryOutcome:
            if reason is BoundaryReason.BIND or reason is BoundaryReason.SCOPE:
                # 受监督的波循环: hand control back to the CEO ReAct loop — record the
                # boundary (BIND = late-bound node(s) to finalise; SCOPE = deviating
                # node(s) whose un-run downstream the CEO re-steers) for ``_drive`` to
                # brief + stash, and YIELD (soft pause: drain, partial map, the un-run
                # tail left for the ``replan`` resume). Neither needs a user channel; the
                # CEO resumes via the replan tool.
                self._pending_boundary = (reason, list(nodes))
                return BoundaryOutcome.YIELD
            # CHECKPOINT (user plan_review). When the hook is wired only for the BIND arm
            # (no live interactive user), the user channel is absent — a checkpoint_after
            # marker then stays soft-inert (proceed without pausing), matching its
            # no-hook behaviour.
            if registry is None or conversation_id is None:
                return BoundaryOutcome.PROCEED

            checkpoint_id = new_id()
            steps = [self._review_step(n, completed) for n in nodes]
            pending = self._pending_preview(plan, completed)
            required = plan_review_required(
                checkpoint_id=checkpoint_id,
                conversation_id=conversation_id,
                steps=steps,
                pending=pending,
            )
            # Durable backstop BEFORE the wait (best-effort; on failure the in-memory
            # resolve below still settles the live turn). Includes the about-to-emit
            # `required` in the frame's journal so a resume replays the pause.
            await self._persist_suspension(
                checkpoint_id, plan, completed, steps, pending, required
            )
            try:
                response = await registry.suspend(
                    checkpoint_id,
                    conversation_id,
                    kind=InteractionKind.PLAN_REVIEW,
                    payload={"steps": steps, "pending": pending},
                    timeout=timeout,
                    on_suspended=lambda: self._sink.emit(required),
                )
            except TimeoutError:
                logger.info("plan_review.timeout", checkpoint_id=checkpoint_id)
                response = CheckpointResponse(decision=CheckpointDecision.CONTINUE)
            # Reached only on resolve / timeout — a cancel (disconnect) raises
            # CancelledError, which propagates PAST this and leaves the frame for
            # /resume. The live path settled in-process, so drop the stale backstop.
            await self._drop_suspension()
            self._sink.emit(
                plan_review_resolved(
                    checkpoint_id=checkpoint_id,
                    decision=response.decision.value,
                    note=response.note,
                )
            )
            if response.decision is CheckpointDecision.ADJUST and response.note.strip():
                self._apply_steer(
                    plan, completed, {n.run_id for n in nodes}, response.note.strip()
                )
            return (
                BoundaryOutcome.ABORT
                if response.decision is CheckpointDecision.STOP
                else BoundaryOutcome.PROCEED
            )

        return on_boundary

    def _can_persist_suspension(self) -> bool:
        """Whether this checkpoint should be durably persisted (结构化挂起 2b).

        Top-level captain's delegate only (``depth == 0``) and the turn's
        ``message_id`` + persist closures wired — a nested sub-team's checkpoint and
        any standalone / un-wired run keep 2a in-memory behaviour (no frame)."""
        return bool(
            self._depth == 0
            and self._message_id
            and self._suspension_saver is not None
            and self._conversation_id
        )

    async def _persist_suspension(
        self, checkpoint_id, plan, completed, steps, pending, required_event
    ) -> None:
        """Capture + persist the durable suspension frame for this pause (2b).

        Reads the CEO transcript off the ``captain_transcript`` contextvar (published
        by the captain executor) — without it a faithful resume is impossible, so
        capture is skipped (the live in-memory resolve still works). Folds the
        about-to-emit ``required_event`` into the frame's journal so a resume replays
        the pause+resolution as a pair. Best-effort: the saver swallows its own errors.
        """
        if not self._can_persist_suspension():
            return
        from agentcore.core.log_context import get_log_value
        from agentcore.runtime.suspension import (
            PlanReviewSuspension,
            captain_transcript,
            find_tool_call_id,
            turn_history,
        )

        transcript = captain_transcript.get()
        if not transcript:
            logger.info("suspension.no_transcript", checkpoint_id=checkpoint_id)
            return
        from agentcore.runtime.facts import snapshot_fact_log

        journal = list(self._sink.execution_journal() or [])
        journal.append(
            {
                "type": required_event.type.value,
                "payload": required_event.payload,
                "timestamp": required_event.timestamp,
            }
        )
        # The §18.3 fact-log stream at this same instant — the persist source (the
        # display ``journal`` above is the degraded fallback). The plan_review card is
        # emitted only AFTER this save, so fold it in so the persisted stream carries it.
        journal_entries = snapshot_fact_log(
            trailing=[
                {
                    "kind": required_event.type.value,
                    "payload": required_event.payload,
                    "ts": required_event.timestamp,
                }
            ]
        )
        frame = PlanReviewSuspension(
            message_id=self._message_id or "",
            conversation_id=self._conversation_id or "",
            user_id=self._base_tool_context.user_id,
            captain_run_id=self._captain_run_id or "",
            checkpoint_id=checkpoint_id,
            tool_call_id=find_tool_call_id(transcript, "delegate"),
            base_system_prompt=self._system_prompt,
            user_message=self._user_message,
            transcript=list(transcript),
            history=list(turn_history.get() or []),
            plan=plan,
            completed=dict(completed),
            journal=journal,
            journal_entries=journal_entries,
            steps=steps,
            pending=pending,
            trace_id=get_log_value("trace_id"),
        )
        await self._suspension_saver(frame)  # type: ignore[misc]

    async def _drop_suspension(self) -> None:
        """Delete the durable frame after a live in-process resolve / timeout (2b)."""
        if self._can_persist_suspension() and self._suspension_deleter is not None:
            await self._suspension_deleter(self._message_id or "")

    @staticmethod
    def _record_plan_snapshot(plan: RunPlan) -> None:
        """Journal the current plan as a ``plan_snapshot`` fact (执行级事件溯源 Phase 2).

        The execution source for ``frame.plan`` (its exit): recorded at build and after each
        ``adjust`` steer, so the LAST snapshot is the cumulative DAG and ``plan_from_journal``
        rebuilds it on resume. A no-op outside a fact-log-bound turn (``record_turn_fact``
        drops it) — e.g. a same-process resume (no log) or a standalone run — so the
        in-memory carrier stays the fallback there, exactly like the run-final facts.
        """
        from agentcore.runtime.facts import record_turn_fact
        from agentcore.runtime.runs.serialize import plan_snapshot_fact

        record_turn_fact(plan_snapshot_fact(plan))

    @staticmethod
    def _apply_steer(
        plan: RunPlan, completed: dict, checkpoint_ids: set[str], note: str
    ) -> None:
        """Inject a plan_review ``adjust`` note onto the checkpoint nodes' not-yet-run
        *transitive dependents* — exactly the work that builds on the reviewed output.

        The steer is feedback about what the checkpoint node(s) produced, so only
        nodes that (transitively) ``depends_on`` a checkpoint node are redirected; an
        independent branch still pending at the pause never saw the reviewed output
        and is left untouched (避免污染无关并行支). The scheduler re-reads specs from
        ``plan.nodes`` each wave, so mutating a pending node's :attr:`RunSpec.steer`
        here lands before it runs; the executor renders it as a high-priority
        instruction block. Nodes already in ``completed`` are done and skipped.
        Accumulates (one bullet per adjust) so a node steered across multiple
        checkpoints keeps every note.

        Re-snapshots the steered plan to the journal so a later durable pause's
        ``plan_from_journal`` reflects the accumulated steer (frame.plan 退场).
        """
        targets = DelegateTool._downstream_of(plan, checkpoint_ids)
        block = f"- {note}"
        for node in plan.nodes:
            if node.run_id in completed or node.run_id not in targets:
                continue
            node.steer = f"{node.steer}\n{block}" if node.steer else block
        DelegateTool._record_plan_snapshot(plan)

    @staticmethod
    def _downstream_of(plan: RunPlan, roots: set[str]) -> set[str]:
        """Run ids that (transitively) ``depends_on`` any node in ``roots`` (the just-
        completed checkpoint nodes).

        Fixpoint over the dependency edges: a node is downstream if any of its deps is
        a root or already-downstream. The roots themselves are excluded (they are
        done). Used to scope an ``adjust`` steer to the reviewed output's dependents
        rather than every pending node.
        """
        downstream: set[str] = set()
        changed = True
        while changed:
            changed = False
            for node in plan.nodes:
                if node.run_id in downstream or node.run_id in roots:
                    continue
                if any(dep in roots or dep in downstream for dep in node.depends_on):
                    downstream.add(node.run_id)
                    changed = True
        return downstream

    def _review_step(self, node: RunSpec, completed: dict) -> dict[str, Any]:
        """One just-completed checkpoint node's review card entry (run_id + role +
        a capped product excerpt the user recognises it by)."""
        state = completed.get(node.run_id)
        summary = (state.content if state else "") or ""
        if len(summary) > _PLAN_REVIEW_SUMMARY_CHARS:
            summary = summary[:_PLAN_REVIEW_SUMMARY_CHARS] + "…"
        return {"run_id": node.run_id, "role": node.role or node.run_id, "summary": summary}

    def _pending_preview(self, plan: RunPlan, completed: dict) -> list[dict[str, Any]]:
        """The downstream nodes about to run once the user proceeds (run_id + role),
        so the card shows what is being gated. Nodes not yet terminal at pause time."""
        return [
            {"run_id": n.run_id, "role": n.role or n.run_id}
            for n in plan.nodes
            if n.run_id not in completed
        ]

    def _accumulate_usage(self, results: dict) -> dict[str, int]:
        """Sum this call's worker token usage and fold it into the turn total.

        Returns THIS call's usage (an adaptive captain may delegate repeatedly), so
        the result metadata reports only this batch while the accumulator carries
        the running turn total.
        """
        call = {"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0}
        for state in results.values():
            for key in call:
                call[key] += state.usage.get(key, 0)
        self._acc.add_usage(call)
        return call

    def _collect_ledger(self, plan, results: dict) -> None:
        """Capture each worker run that metered LLM usage as a per-run cost row.

        Reads the cost the executor already priced onto each terminal RunState
        (no re-pricing) and parents the row to the captain. Runs that never hit
        the LLM (skipped, or failed before any call) carry no usage and are not
        billed (the accumulator guards on ``state.usage``).
        """
        for node in plan.nodes:
            state = results.get(node.run_id)
            if state:
                self._acc.add_run_cost(node, state, parent_run_id=self._captain_run_id)

    def _collect_citations(self, results: dict) -> None:
        """Fold COMPLETED workers' web sources into this turn's source list.

        Merged in plan order, de-duped and capped, so a page two workers both found
        collapses to one card. Only COMPLETED runs contribute — a hard-failed
        worker's output is discarded by the CEO, so its sources don't back the
        answer (the accumulator guards on the phase). The pipeline later merges this
        into the turn's shared card alongside the CEO's own searches.
        """
        for state in results.values():
            self._acc.add_citations(state)

    def _register_sessions(self, plan, results: dict) -> list:
        """Keep each COMPLETED worker alive as a recoverable RunSession (留人), and
        return the sessions registered (so ``execute`` can write them through to the
        durable roster, P3).

        The worker's full transcript was captured on its RunState; preserve it in
        the turn's roster so the CEO can 定向唤回 (revise) the SAME author to continue
        on its own draft, instead of re-delegating a cold new worker. Only COMPLETED
        runs that captured a transcript are kept — a failed / empty run has nothing
        to continue, so it falls back to 甲 (re-delegate). No-op when 热修 is disabled
        (standalone / tests, ``session_store is None``)."""
        if self._session_store is None:
            return []
        from agentcore.runtime.runs import RunPhase, RunSession

        registered = []
        for node in plan.nodes:
            state = results.get(node.run_id)
            if state and state.phase is RunPhase.COMPLETED and state.transcript:
                session = RunSession(
                    run_id=node.run_id,
                    spec=node,
                    transcript=state.transcript,
                    content=state.content,
                )
                self._session_store.put(session)
                registered.append(session)
        return registered

    def _escalation_block(self, plan, results: dict) -> str:
        """The CEO-facing「队员升级」section, or "" when no worker escalated.

        Lists every worker escalation (role + question + its暂用假设, blockers first /
        marked) and tells the CEO to resolve them BEFORE finalizing — with its own
        levers: ask_user (user must decide), revise (recall the author with the answer),
        or a fresh delegate. The workers already delivered under their assumptions, so
        this is a steer-before-收尾, not a hard stop."""
        pending: list[tuple[bool, str]] = []  # (blocking, line) — needs CEO action
        answered: list[str] = []  # 阻塞式求决策: already settled with the user mid-wave
        for node in plan.nodes:
            state = results.get(node.run_id)
            if not state or not state.escalations:
                continue
            label = node.role or node.run_id
            for e in state.escalations:
                question = str(e.get("question") or "").strip()
                if not question:
                    continue
                # 阻塞式求决策: a worker that blocked and got the user's answer mid-wave is
                # ALREADY settled — list it as 已答 (so the CEO folds the answer in) and keep
                # it OUT of the「请先处理」action list, so the CEO doesn't re-ask (设计 §4.5).
                # raised (non-blocking) + timeout (blocked but no answer → fell back to its
                # assumption) still need the CEO's attention.
                if str(e.get("status") or "raised") == "resolved":
                    answer = str(e.get("answer") or "").strip()
                    answered.append(f"- {label}：{question} → 用户已答：{answer}")
                    continue
                blocking = bool(e.get("blocking"))
                mark = "【关键阻塞】" if blocking else ""
                line = f"- {mark}{label}：{question}"
                assumption = str(e.get("assumption") or "").strip()
                if assumption:
                    line += f"（其暂用假设：{assumption}）"
                pending.append((blocking, line))
        if not pending and not answered:
            return ""
        out = ""
        if pending:
            pending.sort(key=lambda it: not it[0])  # blocking=True first
            out += (
                "\n### ⚠️ 队员升级了待决问题（请先处理再收尾）\n"
                "以下是队员无法独自拍板、需要你定夺的关键岔路 / 缺失信息。它们已按各自的暂定假设"
                "继续交付，但你应先处理这些问题：能自己答的就在概览里给出并据此判断相关产物是否需"
                "返工；确需用户拍板的就用 ask_user 问（可把问题 near-verbatim 转给用户）；需要原"
                "作者据答案重做的就用 revise 唤回。\n"
                + "\n".join(line for _, line in pending)
            )
        if answered:
            out += (
                "\n### ✅ 已当场答复的升级（用户在执行中已拍板，无需再问）\n"
                "以下升级队员已直接问到用户、拿到答复并据此续跑；把这些结论纳入你的收尾叙事即可，"
                "不要再用 ask_user 重复问同样的问题。\n" + "\n".join(answered)
            )
        return out

    def _format_for_ceo(self, plan, results: dict) -> str:
        """Render the workers' products as the CEO's overview input.

        The CEO reads each worker's product here so its overview is accurate, but is
        instructed to write only a SHORT synthesis (决策①) — the user reads each
        worker's FULL output in the UI, not in the CEO's reply.

        CEO 综述输入瘦身: each product is sized by the shared fidelity discipline
        (``runs/fidelity.py``) — the same one a worker's dep-injection uses, applied at
        the OTHER fan-in (all workers → the CEO). The motive is correctness, not only
        cost: this aggregate used to be blunt head-chopped by the single ToolResult
        ``output_limit``, silently dropping late workers AND this method's own trailing
        instructions (防幻觉铁律 / 收尾指引). Now a file-producer is digested (its full
        product is on disk + shown in the UI; the CEO can ``file_read``) while prose
        workers SHARE one water-filled budget (head+tail trimmed on overflow) — so every
        worker stays represented and the closing instructions always survive under the
        ``output_limit`` net. Deliberately NOT keyed on ``result_handling`` (that knob
        only governs upstream→downstream injection, never the CEO return — §2.3).
        """
        lines = ["## 团队执行结果（据此写一段简短概览交给用户；完整详情用户自行查看）"]
        # 队员升级（worker → 你）置顶：这些是队员无法独自拍板、需要你定夺的待决问题。它们已
        # 按各自的暂定假设继续交付了，但你应在收尾前先处理——这是 worker 唯一的向上通道，别忽略。
        escalation_block = self._escalation_block(plan, results)
        if escalation_block:
            lines.append(escalation_block)

        # SINGLE SOURCE: each worker's role-attributed product (sized by the shared
        # fidelity discipline). Consumed twice — rendered into the CEO synthesis text
        # below AND shipped as the captain's channel⑤ run_context — so 用户看到的回传 ==
        # LLM 此处读到的, with no second formatting path (上下文传递可视化 §一 单一源).
        products = self._worker_products(plan, results)
        self._emit_captain_readback(products)
        for wp in products:
            lines.append(
                f"\n### {wp['role']}（{wp['status']}） · run_id: `{wp['run_id']}`\n{wp['body']}"
            )
        lines.append(
            "\n---\n以上为各 worker 的产出（较长或已落盘者在此为摘要 / 指针，完整内容用户可在"
            "界面逐个展开查看，落盘文件你也可 file_read 取用）。各成员写入工作区的"
            "文件已列于其「文件产出（已写入工作区）」一行——这就是本次落盘的产物清单（地面真相）："
            "除非清单为空或明显不全，否则无需再用 file_list / file_read 去工作区核对，直接据此收尾即可。\n"
            "⚠️ 防幻觉铁律：一个 worker 是否真把文件写进了工作区，只以它有没有「文件产出」行为准。"
            "若某 worker 的正文声称 / 暗示自己创建或写入了文件，却没有「文件产出」行（即落盘清单为空），"
            "则这些文件并未真正写入——你绝不能据此向用户报告文件已创建或该交付已完成；应把这类文件"
            "交付判为【未达成】，用 revise 唤回原作者真正调用 file_write 落盘，或重新委派。"
            "（仅产出文本结论的 worker——调研 / 分析 / 辩论 / 对比等——本就没有文件产出，属正常，"
            "不在此列，也不必在概览里提它。）\n"
            "请用你自己的声音写一段【简短概览】：综述各成员的关键结论、串起整体、"
            "指引用户去看细节即可——不要逐字复述每个 worker 的全文，也不要罗列内部"
            "步骤或 Agent。如仍需补充工作，可再次调用 delegate；若用户希望对其中某个产物"
            "做小改 / 增补、且仍由原角色来改，可用 revise（传该产物上面的 run_id + 修改"
            "意见）唤回原作者在原稿基础上续写，而不必从零重派。"
        )
        output = "\n".join(lines)
        # 调度埋点量化（收尾侧）: quantify CEO 综述输入瘦身 so production confirms the blunt
        # output_limit net no longer fires (``capped=False``) and the budget can be
        # calibrated on real ratios. ``raw_chars`` is the unbounded all-worker total the
        # old path concatenated before its head-chop; ``ratio`` = final / raw.
        raw_chars = sum(len(s.content) for s in results.values() if s and s.content)
        logger.info(
            "delegate.synthesis",
            call=self._calls,
            workers=len(plan.nodes),
            pointers=sum(1 for p in products if p["fidelity"] == "pointer"),
            prose=sum(1 for p in products if p["fidelity"] == "pass_through"),
            raw_chars=raw_chars,
            final_chars=len(output),
            ratio=round(len(output) / raw_chars, 2) if raw_chars else 1.0,
            capped=len(output) > _DELEGATE_OUTPUT_LIMIT,
        )
        return output

    def _worker_products(self, plan, results: dict) -> list[dict[str, Any]]:
        """Each worker's product folded back to the CEO — the SINGLE SOURCE behind BOTH
        the CEO synthesis input (:meth:`_format_for_ceo`) AND the captain's channel⑤
        ``run_context`` (上下文传递可视化: 队员产物回流 CEO). One record per ``plan.nodes``
        entry: ``{role, run_id, status, body, fidelity, truncated, files}``, sized by the
        shared fidelity discipline (``runs/fidelity.py``) — a file-producer is digested
        (full product on disk + in the UI → ``pointer``); prose workers SHARE one
        water-filled budget (``pass_through``, head+tail trimmed on overflow). Deliberately
        NOT keyed on ``result_handling`` (that knob only governs upstream→downstream
        injection, never the CEO return — §2.3)."""
        from agentcore.runtime.runs.constants import (
            CEO_SYNTHESIS_BUDGET,
            DEP_POINTER_SUMMARY_CHARS,
        )
        from agentcore.runtime.runs.fidelity import allocate, truncate_head_tail
        from agentcore.runtime.workspace import summarize

        # Classify each product's fidelity once (plan.nodes order): a file-producer is
        # digested (on disk + in the UI), everything else is PROSE that shares the
        # water-filled budget. Only the prose draws on it.
        def _mode(node) -> str:
            st = results.get(node.run_id)
            if not st or not st.content:
                return "none"  # error / 无输出 — already short, shown verbatim
            if st.files_touched:
                return "pointer"  # full product is on disk + in the UI → digest only
            return "pass_through"

        modes = {node.run_id: _mode(node) for node in plan.nodes}
        # Water-fill the prose budget across the pass_through products, in plan.nodes
        # order — the loop consumes this iterator in the SAME order (kept in sync by
        # filtering on the same mode), exactly like _dep_context_blocks.
        allowances = iter(
            allocate(
                [
                    len(results[node.run_id].content)
                    for node in plan.nodes
                    if modes[node.run_id] == "pass_through"
                ],
                CEO_SYNTHESIS_BUDGET,
            )
        )
        products: list[dict[str, Any]] = []
        for node in plan.nodes:
            state = results.get(node.run_id)
            status = state.phase.value if state else "unknown"
            label = node.role or node.run_id
            mode = modes[node.run_id]
            fidelity = ""
            truncated = False
            if mode == "pointer":
                body = summarize(state.content, limit=DEP_POINTER_SUMMARY_CHARS)
                fidelity, truncated = "pointer", True
            elif mode == "pass_through":
                allowance = next(allowances)
                body = truncate_head_tail(state.content, allowance)
                fidelity = "pass_through"
                truncated = len(state.content) > allowance
            elif state and state.error:
                body = f"（失败：{state.error}）"
            else:
                body = "（无输出）"
            if state and state.warnings:
                warns = "；".join(state.warnings)
                body += f"\n\n> 质检提醒（未完全达标，请判断是否需要返工）：{warns}"
            if state and state.escalations:
                body += (
                    f"\n\n> 已升级 {len(state.escalations)} 项待决问题（见顶部「队员升级了"
                    "待决问题」，请先处理再据此判断本产物是否需返工）"
                )
            files = list(state.files_touched) if state and state.files_touched else []
            if files:
                produced = "、".join(f"`{p}`" for p in files)
                body += f"\n\n> 文件产出（已写入工作区）：{produced}"
            products.append(
                {
                    "role": label,
                    "run_id": node.run_id,
                    "status": status,
                    "body": body,
                    "fidelity": fidelity,
                    "truncated": truncated,
                    "files": files,
                }
            )
        return products

    def _emit_captain_readback(self, products: list[dict[str, Any]]) -> None:
        """上下文传递可视化 通道⑤: ship the team's products back to the CEO bubble as a
        SECOND captain ``run_context`` (channel ``team_result``) — the captain's received
        context GROWS by what it read back from the team. Same ``products`` as the CEO
        synthesis text (单一源), each block carrying its provenance (来源角色 / 保真度 / 是否
        截断 / 文件). Top-level batches only (``depth == 0`` + a real captain run id): a
        nested sub-team's readback feeds its worker-captain, not the turn's CEO bubble, and
        its run is kind=agent (would fold onto a node, not turn-level), so it is skipped."""
        if self._depth != 0 or not self._captain_run_id:
            return
        blocks = [
            {
                "channel": "team_result",
                "heading": f"{wp['role']}（{wp['status']}）",
                "body": wp["body"],
                "chars": len(wp["body"]),
                "truncated": wp["truncated"],
                "source_role": wp["role"],
                "source_run_id": wp["run_id"],
                "fidelity": wp["fidelity"],
                "files": wp["files"],
            }
            for wp in products
        ]
        if blocks:
            self._sink.emit(
                run_context(self._captain_run_id, self._captain_run_id, blocks)
            )

    def _run_payload(self, node) -> dict[str, Any]:
        """One worker's plan-time descriptor for the graph: identity + topology,
        plus the optional 辩论/审查 display tags when the CEO marked an opposing batch.

        ``stance``/``group``/``round`` (前端UX设计.md §四) ride here display-only: the
        frontend reads them to render an opposing batch side-by-side under a「辩论」
        title and lay multi-round debates out round-by-round, while the scheduler/
        executor ignore them (执行仍是普通并行 DAG). Omitted when empty/0, so an
        ordinary parallel/DAG batch's payload is byte-for-byte unchanged.
        """
        payload: dict[str, Any] = {
            "id": node.run_id,
            "agent_id": node.agent_id,
            "task": node.task,
            "depends_on": node.depends_on,
            # 阶段2 grouping: a sub-worker carries its captain worker's run id (a
            # real node on the graph) so the frontend groups it under that parent;
            # a top-level worker carries the CEO captain run id — a real CAPTAIN
            # node (declared in _plan_event) it hangs under.
            "parent_run_id": node.parent_run_id,
        }
        if node.stance:
            payload["stance"] = node.stance
        if node.group:
            payload["group"] = node.group
        if node.round:
            payload["round"] = node.round
        return payload

    def _plan_event(self, execution_id: str, plan):
        """Pre-declare this delegate batch's roster + runs so the graph lights up.

        The top-level CEO batch (``depth == 0``) also declares the CAPTAIN root
        node — the CEO chat loop itself — so the graph has a real 汇聚点 the workers
        hang under (their ``parent_run_id`` points at it). The client dedupes it
        across an adaptive captain's repeated batches. A nested sub-team's captain
        is a worker that is already a node, so it is not re-declared.
        """
        roles = list(dict.fromkeys(n.role for n in plan.nodes if n.role))
        agents = [self._card(n) for n in plan.nodes]
        runs = [self._run_payload(n) for n in plan.nodes]
        if self._depth == 0 and self._captain_run_id:
            agents.insert(0, self._captain_card())
            runs.insert(
                0,
                {
                    "id": self._captain_run_id,
                    "agent_id": self._captain_run_id,
                    "task": "",
                    "depends_on": [],
                    "parent_run_id": None,
                    "kind": "captain",
                },
            )
        return run_plan(
            execution_id=execution_id,
            plan_type="multi_agent",
            task_summary=f"{len(plan.nodes)} 个 worker：{'、'.join(roles)}" if roles else "",
            agents=agents,
            runs=runs,
        )

    def _captain_card(self) -> dict[str, Any]:
        """Roster card for the CEO captain root node (display only — the captain
        runs the ``chat`` profile: thinking·high, surfaced as the 强 tier)."""
        return {
            "id": self._captain_run_id,
            "role": "CEO",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        }

    def _card(self, node) -> dict[str, Any]:
        """Roster entry with the node's *effective* (post-clamp) thinking/effort."""
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
