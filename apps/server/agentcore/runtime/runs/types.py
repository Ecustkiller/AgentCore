"""Run model type core (统一 Run 模型 第一阶段) — the typed substrate the scheduler
and executor build on.

A turn holds one *tree* of Runs: the root is the main reply engine; every
delegated worker, DAG node, and (阶段2) synthesis / candidate-selection is a child
Run node. This module fixes the *shape* of a Run — its spec (:class:`RunSpec`) +
node policy (:class:`RunPolicy`) + live state (:class:`RunState`) — and the phases
it moves through (:class:`RunPhase`). The plan that holds nodes lives in
``runs.plan``; the scheduler that drives them in ``runs.wave``.

第一阶段范围：worker 以「内联角色」声明（无独立 Agent 实体），因此 ``RunSpec`` 直接携带
角色/目标/工具/模型档位等执行所需字段；``agent_id`` 在本阶段即等于 ``run_id``（事件与图
节点标识沿用），``agent_name`` 取角色名做展示。ARENA / SYNTHESIS 两种 kind 与 RunPolicy
中的审计/契约/best-of-n 等槽位先声明、暂不启用，留给阶段2。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal


class RunKind(StrEnum):
    """What a Run node *is*.

    The scheduler treats every kind uniformly; the kind only selects which
    executor and policy defaults apply when the node runs. 第一阶段只产出 AGENT；
    ARENA / SYNTHESIS 预留给阶段2。
    """

    AGENT = "agent"  # a delegated / DAG-step worker run
    ARENA = "arena"  # 阶段2: multi-candidate (best-of-n) run
    SYNTHESIS = "synthesis"  # 阶段2: a captain's 合稿 over its children's outputs


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
    tools: list[str] = field(default_factory=list)
    model_preference: str = "strong"
    thinking: bool | None = None
    reasoning_effort: str | None = None
    expected_output: str = ""
    # ── topology / governance ──
    depends_on: list[str] = field(default_factory=list)
    parent_run_id: str | None = None
    depth: int = 0
    policy: RunPolicy = field(default_factory=RunPolicy)
    # Fan-out awareness: a concise list of the *other* nodes running in parallel
    # (no dependency relationship), injected into this node's child context so
    # siblings coordinate instead of overlapping. Populated by ``build_run_plan``
    # only for a flat parallel batch (a DAG node gets upstream product context
    # instead; a lone task leaves it blank).
    sibling_summary: str = ""


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
    error: str = ""
    # Soft contract shortfalls on a COMPLETED run: the output was accepted (a
    # non-strict contract failed after retries) but carries these caveats, which
    # the captain sees in the aggregated result so it can judge / re-delegate.
    warnings: list[str] = field(default_factory=list)
    model: str = ""
    duration_ms: int = 0
    rounds: int = 0
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    cost: dict[str, int] = field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        return self.phase in TERMINAL_PHASES
