"""Single-point turn-state rehydration from ``turn_paused`` (batch 5).

Resume reads the last ``turn_paused`` in the frame's journal and rehydrates
display + control state in one place. Old frames without the fact keep legacy
heuristics (empty timeline seed, transcript pre_pause, frame.citations only).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events import EventSink
from agentcore.runtime.facts import TurnPausedFact, pre_pause_from_journal
from agentcore.runtime.loop_controller import LoopController
from agentcore.runtime.suspension import (
    PlanReviewSuspension,
    TeamPreviewSuspension,
    TurnSuspension,
)

logger = get_logger(__name__)


@dataclass
class RehydratedTurnState:
    """Resume-side turn state resolved from ``turn_paused`` (or legacy fallbacks)."""

    pre_pause_content: str | None = None
    """Authoritative deliverable content when ``from_turn_paused``; else ``None``
    (caller keeps the transcript heuristic)."""

    pre_pause_reasoning: str = ""
    controller_seed: dict[str, Any] | None = None
    citations: list[dict[str, Any]] = field(default_factory=list)
    from_turn_paused: bool = False
    fact: TurnPausedFact | None = None


def rehydrate_from_turn_paused(
    *,
    sink: EventSink,
    suspension: TurnSuspension,
) -> RehydratedTurnState:
    """Seed sink display state + resolve content/reasoning/controller/citations.

    Call after ``sink.seed_journal(...)``. When the journal has no ``turn_paused``,
    returns legacy citations from ``suspension.citations`` and leaves pre_pause /
    controller unset so the caller keeps current heuristics.
    """
    fact = pre_pause_from_journal(suspension.journal_entries)
    if fact is None:
        return RehydratedTurnState(
            citations=list(suspension.citations or []),
            from_turn_paused=False,
        )

    if fact.process:
        sink.seed_process(list(fact.process))
    if fact.run_processes:
        sink.seed_run_processes(dict(fact.run_processes))

    # G2: fact is authoritative; frame.citations is the fallback.
    citations = list(fact.citations or suspension.citations or [])
    controller = dict(fact.controller) if fact.controller else {}

    logger.info(
        "pipeline.resume_rehydrated",
        checkpoint_id=fact.checkpoint_id,
        suspension_kind=fact.suspension_kind,
        process_steps=len(fact.process or []),
        run_process_keys=len(fact.run_processes or {}),
        citations=len(citations),
        has_controller=bool(controller),
    )
    return RehydratedTurnState(
        pre_pause_content=fact.content or "",
        pre_pause_reasoning=fact.reasoning or "",
        controller_seed=controller,
        citations=citations,
        from_turn_paused=True,
        fact=fact,
    )


def batch_shape_for_settled_suspension(
    suspension: TurnSuspension,
) -> tuple[int, bool]:
    """``(node_count, has_deps)`` for settle-side ``mark_post_delegate`` (G5)."""
    if isinstance(suspension, TeamPreviewSuspension) and suspension.primitive == "debate":
        # Live debate returns without batch meta → note_delegate_batches uses (0, False).
        return 0, False

    plan = getattr(suspension, "plan", None)
    nodes = getattr(plan, "nodes", None) if plan is not None else None
    if isinstance(nodes, list) and nodes:
        return len(nodes), any(bool(getattr(n, "depends_on", None)) for n in nodes)

    if isinstance(suspension, TeamPreviewSuspension) and suspension.workers:
        return (
            len(suspension.workers),
            any(bool(w.get("depends_on")) for w in suspension.workers if isinstance(w, dict)),
        )

    return 0, False


def mark_controller_after_settle(
    controller_seed: dict[str, Any] | None,
    suspension: TurnSuspension,
) -> dict[str, Any] | None:
    """After plan_review / team_preview settle, latch post_delegate with batch shape.

    Only meaningful on the ``turn_paused`` path (caller gates on ``from_turn_paused``):
    the snapshot's ``post_delegate`` is False because the pause happened before the
    delegate/debate tool returned. Ask-user settles leave the seed unchanged.
    """
    if not isinstance(suspension, (PlanReviewSuspension, TeamPreviewSuspension)):
        return controller_seed

    controller = LoopController()
    if controller_seed:
        controller.apply_seed(controller_seed)
    node_count, has_deps = batch_shape_for_settled_suspension(suspension)
    controller.mark_post_delegate(node_count=node_count, has_deps=has_deps)
    seed = controller.export_seed()
    logger.info(
        "pipeline.resume_settle_post_delegate",
        kind=suspension.kind.value,
        node_count=node_count,
        has_deps=has_deps,
        first_batch_substantial=seed.get("first_batch_substantial"),
    )
    return seed
