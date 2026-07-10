"""Worker 内部路由：Intake + Escalation Gate + Sequential Split（Phase 2）。

→ 见：runtime/routing/models.py、intake.py、gate.py、split.py、subworker.py
"""

from __future__ import annotations

from agentcore.runtime.routing.gate import (
    classify_problem,
    evaluate_after_tools,
    signals_as_dicts,
)
from agentcore.runtime.routing.intake import assess_intake
from agentcore.runtime.routing.models import (
    Complexity,
    EscalationKind,
    EscalationSignal,
    ExecutionStrategy,
    GateVerdict,
    IntakeResult,
    ProblemLayer,
    SplitBudget,
    SplitDecision,
    SplitPressure,
    SplitTrigger,
    SubTaskSpec,
    SubWorkerBrief,
    SubWorkerResult,
)
from agentcore.runtime.routing.split import (
    allocate_subtask_budgets,
    assess_split,
    detect_split_pressure,
    summarize_parent_progress,
    total_tool_failures,
)
from agentcore.runtime.routing.subworker import (
    aggregate_results,
    apply_sequential_split_after_tools,
    briefs_from_decision,
    build_subworker_brief,
    extract_result_from_content,
    fold_results_for_parent,
    new_subworker_id,
    run_sequential_subworkers,
    run_subworker,
)

__all__ = [
    "Complexity",
    "ExecutionStrategy",
    "ProblemLayer",
    "EscalationKind",
    "IntakeResult",
    "EscalationSignal",
    "GateVerdict",
    "SplitTrigger",
    "SplitBudget",
    "SplitPressure",
    "SubTaskSpec",
    "SplitDecision",
    "SubWorkerBrief",
    "SubWorkerResult",
    "assess_intake",
    "evaluate_after_tools",
    "classify_problem",
    "signals_as_dicts",
    "detect_split_pressure",
    "assess_split",
    "allocate_subtask_budgets",
    "summarize_parent_progress",
    "total_tool_failures",
    "new_subworker_id",
    "build_subworker_brief",
    "briefs_from_decision",
    "extract_result_from_content",
    "fold_results_for_parent",
    "aggregate_results",
    "run_subworker",
    "run_sequential_subworkers",
    "apply_sequential_split_after_tools",
]
