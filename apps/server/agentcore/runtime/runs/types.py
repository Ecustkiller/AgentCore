"""Run model type core (统一 Run 模型 第一阶段) — the typed substrate the scheduler
and executor build on.

A turn holds one *tree* of Runs: the ``CAPTAIN`` root is the CEO chat loop (the
reply engine); every delegated worker / DAG node is an ``AGENT`` child. This module
fixes the *shape* of a Run
— its spec (:class:`RunSpec`) +
node policy (:class:`RunPolicy`) + live state (:class:`RunState`) — and the phases
it moves through (:class:`RunPhase`). The plan that holds nodes lives in
``runs.plan``; the scheduler that drives them in ``runs.wave``.

第一阶段范围：worker 以「内联角色」声明（无独立 Agent 实体），因此 ``RunSpec`` 直接携带
角色/目标/工具/模型档位等执行所需字段；``agent_id`` 在本阶段即等于 ``run_id``（事件与图
节点标识沿用），``agent_name`` 取角色名做展示。RunPolicy 中的审计/契约/best-of-N 择优
（``candidates``）等槽位先声明、暂不启用，留给阶段2。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from agentcore.llm.protocol import LLMMessage


class RunKind(StrEnum):
    """What a Run node *is*.

    The scheduler treats every kind uniformly; the kind only selects which
    executor and policy defaults apply when the node runs. A turn is one Run tree:
    the ``CAPTAIN`` root is the CEO chat loop itself (it owns the conversation
    voice and may ``delegate``); every delegated worker / DAG step is an ``AGENT``
    child.

    无独立 ARENA / debate kind：多轮辩论是带 stance/round 展示标记的普通 AGENT DAG，
    best-of-N 择优是 ``RunPolicy.candidates`` 策略位——均守「形状是数据不是模式」，不另
    立节点种类。
    """

    CAPTAIN = "captain"  # the turn's root run: the CEO chat loop (owns the reply)
    AGENT = "agent"  # a delegated / DAG-step worker run


class RunPhase(StrEnum):
    """A Run's lifecycle phase."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    RETRYING = "retrying"


# A run that reached one of these is done; the scheduler advances past it and the
# wave it sits in is complete once all its nodes are terminal.
TERMINAL_PHASES = frozenset({RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.SKIPPED})


class RunOrigin(StrEnum):
    """Where a plan's nodes came from.

    ``TEMPLATE`` = built up-front from the delegate args; ``CAPTAIN`` = appended
    at runtime by a captain via ``delegate`` (阶段2 adaptive case).
    """

    TEMPLATE = "template"
    CAPTAIN = "captain"


@dataclass
class RunContract:
    """A node's delivery contract (阶段2: enforced by a contract gate).

    第一阶段声明位：执行器暂不强制校验，字段保留以便阶段2接入闸门时无需改形状。
    """

    output_format: str = "text"
    required_sections: list[str] = field(default_factory=list)
    output_schema: dict[str, Any] | None = None
    must_contain: list[str] = field(default_factory=list)
    min_length: int = 0
    max_length: int = 0
    # Deliverable-landed postcondition: when True, the run must have called a
    # file-writing tool (file_write / str_replace / file_move) at least once, or the
    # contract gate fails it and auto-reworks. Turns the soft「文件交付物必须落盘、别
    # 粘进聊天」prompt rule into a verifiable code gate over the deterministic
    # files_touched signal (the model declares a file deliverable; the code enforces
    # it landed). Off by default → prose deliverables are unaffected.
    requires_files: bool = False
    strict: bool = False


@dataclass
class RunPolicy:
    """Node-level policy slots.

    第一阶段实际生效的只有 ``on_failure`` / ``max_retries`` / ``retry_delay_ms``
    （WaveScheduler 调度时读取）与 ``result_handling``（执行器拼装下游上下文时读取）。
    其余字段（contract / audit / preflight / candidates / trust / shared_roots /
    concurrency_slot / autosave_artifact）为阶段2声明位，当前不影响行为。
    """

    # on_failure (WaveScheduler enacts these):
    #   retry   = re-run up to ``max_retries`` with backoff, then degrade;
    #   skip    = cascade-skip every dependent (they never run);
    #   abort   = stop scheduling further waves;
    #   degrade = record failed, let dependents proceed (they see the gap).
    on_failure: Literal["abort", "skip", "degrade", "retry"] = "degrade"
    max_retries: int = 0
    retry_delay_ms: int = 0
    timeout_s: int | None = None
    # Fidelity of this node's output when it feeds a dependent node (pass_through
    # / summarize). The executor reads this to size the upstream context block.
    result_handling: str = "pass_through"
    # ── 阶段2 声明位（当前不生效） ──
    concurrency_slot: str | None = None
    shared_roots: bool = False
    trust: str | None = None
    contract: RunContract | None = None
    autosave_artifact: bool = False
    preflight: bool = True
    audit: bool = False
    # best-of-N 择优策略位（阶段2）：candidates>1 = 同一任务并行跑 N 个候选, 按
    # selection_criteria 择优。是「策略」不是「节点种类」——无独立 ARENA kind。
    candidates: int = 1
    selection_criteria: str = ""


@dataclass
class RunSpec:
    """The declared identity + dependencies + policy of one Run node.

    Immutable plan data. 第一阶段「内联角色」：worker 的角色/目标/工具/模型档位直接挂在
    这里（无 Agent 实体）；``agent_id`` 由 builder 铸成 == ``run_id``，``agent_name``
    取角色名，仅用于 ``run_*`` 事件与图节点展示。``wave`` 不在此声明，由
    :meth:`RunPlan.waves` 拓扑推导。
    """

    run_id: str
    task: str
    kind: RunKind = RunKind.AGENT
    # ── identity / display (阶段1: agent_id == run_id, agent_name == role) ──
    agent_id: str = ""
    agent_name: str = ""
    # ── 内联 worker 定义（阶段1：替代独立 Agent 实体） ──
    role: str = ""
    objective: str = ""
    system_prompt_supplement: str | None = None
    # Allowed-tools restriction for this worker, or ``None`` = no restriction (the
    # worker is offered ALL team tools). ``None`` is the fail-safe default: a task
    # that omits ``tools`` must not be silently stranded tool-less. The engine reads
    # an empty list as "offer no tools", which turns a worker with a file/exec
    # deliverable into a text-only agent (the empty-workspace + CEO-hallucinates-
    # success bug), so builder._tools never emits ``[]``. A non-empty list opts the
    # worker into least-privilege (the named, allow-list-intersected tools).
    tools: list[str] | None = None
    model_preference: str = "strong"
    thinking: bool | None = None
    reasoning_effort: str | None = None
    expected_output: str = ""
    # ── 辩论/审查 呈现标记（前端UX设计.md §四，display-only） ──
    # An opposing-batch's display tags: ``stance`` is this node's side (pro/con),
    # ``group`` pairs opposing nodes into one comparison, and ``round`` is its
    # multi-round-debate turn number (1-based; 0 = not a multi-round debate). The
    # scheduler/executor NEVER read these — they ride RunSpec → run_plan → the
    # frontend, which renders tagged runs side-by-side under a「辩论」title and lays
    # multi-round debates out round-by-round. Empty/0 for ordinary parallel/DAG
    # work, so 守住「形状是数据不是模式」: a debate is普通并行 DAG + presentation hints.
    # (Note: ``round`` ≠ ``rounds`` below — the latter counts thinking-text segments.)
    stance: str = ""
    group: str = ""
    round: int = 0
    # ── topology / governance ──
    depends_on: list[str] = field(default_factory=list)
    # Plan-time structured-suspend marker (结构化挂起 2a): when True, the
    # WaveScheduler pauses *after* this node completes and *before* its dependents
    # run, awaiting a user plan_review (continue / stop) over the unified
    # interaction bridge — the one thing a CEO ``ask_user`` cannot express, since a
    # ``delegate`` is atomic to the CEO (it gets no wave-boundary control). Inert by
    # default and whenever the scheduler is driven without an ``on_checkpoint`` hook
    # (autonomous jobs / tests), so a plan with no checkpoint marks runs byte-for-
    # byte as before. → 见设计: docs/03-AI核心/执行引擎架构设计.md §检查点决策语义
    checkpoint_after: bool = False
    parent_run_id: str | None = None
    depth: int = 0
    # Whether this worker may itself delegate one nested level of sub-workers
    # (阶段2 嵌套子任务). Default off — only a CEO task that explicitly opts in gets
    # the delegate tool, and only while ``depth < MAX_DELEGATION_DEPTH`` (executor
    # enforces the cap). depth-2 sub-workers never delegate regardless of this flag.
    can_delegate: bool = False
    policy: RunPolicy = field(default_factory=RunPolicy)
    # Fan-out awareness: a concise list of the *other* nodes that fanned out from
    # the same point — those sharing this node's exact ``depends_on`` set, i.e. the
    # peers it runs in parallel with toward the same juncture (never its own
    # upstream/downstream, which arrive separately via ``depends_on``). Injected into
    # the worker's child context so parallel siblings coordinate instead of
    # overlapping. Populated by ``build_run_plan`` for BOTH a flat parallel batch
    # (all share the empty dep set → all siblings) and a DAG (a「research → writer」
    # fan-out's parallel researchers share their deps → see each other). Narrower
    # than「same wave」on purpose: independent chains that coincidentally share a
    # topological layer are NOT siblings. A node with no same-fan-out peer (a
    # pipeline link, a lone writer) leaves it blank.
    sibling_summary: str = ""
    # Mid-course user steer (结构化挂起 adjust): the note the user gave at a
    # plan_review checkpoint with the ``adjust`` decision, injected by the host hook
    # onto the checkpoint's not-yet-run (transitive) dependents — exactly the work
    # building on the reviewed output, not unrelated parallel branches — so the steer
    # redirects the remaining work (the executor renders it as a high-priority
    # instruction block). Empty for plan-time specs and for ``continue`` / ``stop``;
    # accumulates (one block per adjust) when a node is steered across multiple
    # checkpoints before it runs. → 见设计: docs/03-AI核心/执行引擎架构设计.md §检查点决策语义
    steer: str = ""


@dataclass
class RunState:
    """The mutable execution state of one Run — the live counterpart to the
    immutable :class:`RunSpec`.

    ``usage`` carries this node's token counts (short-key form: {"input",
    "output", "reasoning", "cache_hit", "cache_miss"}) so the caller folds them
    into the turn totals; ``cost`` is this run's priced money in integer nano-USD
    ({"input", "cached", "output", "total"}), computed once by the executor so the
    per-run ledger and UI payroll read it without re-pricing. ``rounds`` counts
    the LLM calls this run made (summed across contract retries).
    """

    phase: RunPhase = RunPhase.QUEUED
    attempt: int = 0
    wave: int = 0
    content: str = ""
    # The run's thinking text (concatenated across rounds). Carried so the CAPTAIN
    # root run can hand its reasoning back to the pipeline for persistence; worker
    # reasoning streams run-scoped (run_reasoning_delta) and is left empty here.
    reasoning: str = ""
    error: str = ""
    # Soft contract shortfalls on a COMPLETED run: the output was accepted (a
    # non-strict contract failed after retries) but carries these caveats, which
    # the captain sees in the aggregated result so it can judge / re-delegate.
    warnings: list[str] = field(default_factory=list)
    # 向上升级（worker → CEO）: decisions / blockers this worker raised via the
    # ``escalate`` tool — each ``{question, assumption, blocking}`` — harvested from the
    # transcript when the run finishes (mirrors ``files_touched``). The DelegateTool
    # surfaces these PROMINENTLY in the CEO-facing aggregate so the CEO resolves them
    # (ask_user / revise / re-delegate) before finalizing. Distinct from ``warnings``:
    # a warning is a soft quality caveat (判断是否返工), an escalation is a worker-flagged
    # 待决问题 it couldn't settle alone. Empty for a run that escalated nothing.
    escalations: list[dict[str, Any]] = field(default_factory=list)
    # Web sources this worker consulted (web_search / read_url), de-duped across
    # contract retries. Collected un-numbered (the worker text is not annotated):
    # the DelegateTool folds these into the turn's shared source card so the user
    # sees what the WHOLE team researched, not just the CEO's own searches.
    citations: list[dict[str, Any]] = field(default_factory=list)
    model: str = ""
    duration_ms: int = 0
    rounds: int = 0
    # Workspace paths this worker created or modified (file_write / str_replace /
    # file_move), derived from its transcript when the run completes. The DelegateTool
    # surfaces these in the CEO-facing aggregate as a「文件产出」manifest so the CEO
    # knows what landed on disk WITHOUT re-listing the workspace to verify (省掉收敛
    # 阶段的冗余 file_list 轮). Best-effort: a file a worker wrote indirectly (e.g. via
    # a code_execute script) is not captured — only direct file-tool calls are.
    files_touched: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    cost: dict[str, int] = field(default_factory=dict)
    # The run's full message transcript (system + task + every assistant/tool turn
    # + the final answer), captured so the run is RECOVERABLE: a 定向唤回 (revise)
    # appends an instruction to this and re-runs the loop — the same author
    # continuing on its own draft (统一「续写」原语, 见 runs/session.py). Empty for a
    # run that never produced one (skipped, or failed before any LLM answer). Typed
    # under TYPE_CHECKING so this module stays import-light.
    transcript: list[LLMMessage] = field(default_factory=list)

    @property
    def is_terminal(self) -> bool:
        return self.phase in TERMINAL_PHASES
