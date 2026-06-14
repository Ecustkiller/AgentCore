"""Run model package (统一 Run 模型).

统一 Run 模型（types / plan / scheduler / wave / concurrency / builder /
executor）是 CEO ``delegate`` 原语的执行地基：``delegate`` 用 ``build_run_plan``
建图、``WaveScheduler`` + ``build_agent_executor`` 分波执行。旧的外部 planner +
``run_multi_agent`` 路径已退役。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.concurrency import (
    current_budget,
    gather_bounded,
    reset_budget,
    set_budget,
)
from agentcore.runtime.runs.executor import build_agent_executor
from agentcore.runtime.runs.plan import RunPlan, RunPlanError
from agentcore.runtime.runs.scheduler import RunExecutor, RunScheduler
from agentcore.runtime.runs.types import (
    TERMINAL_PHASES,
    RunContract,
    RunKind,
    RunOrigin,
    RunPhase,
    RunPolicy,
    RunSpec,
    RunState,
)
from agentcore.runtime.runs.wave import DEFAULT_MAX_PARALLEL, WaveScheduler

__all__ = [
    "build_run_plan",
    "build_agent_executor",
    "RunPlan",
    "RunPlanError",
    "RunExecutor",
    "RunScheduler",
    "WaveScheduler",
    "DEFAULT_MAX_PARALLEL",
    "RunKind",
    "RunPhase",
    "RunOrigin",
    "RunPolicy",
    "RunContract",
    "RunSpec",
    "RunState",
    "TERMINAL_PHASES",
    "gather_bounded",
    "current_budget",
    "set_budget",
    "reset_budget",
]
