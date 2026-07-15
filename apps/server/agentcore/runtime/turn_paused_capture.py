"""Assemble a ``turn_paused`` fact at durable suspension (batch 4 capture side).

Builds the §二契约 payload from the live sink + captain-loop mirror + prior journal
snapshot. Best-effort: missing mirror / sink / fields degrade to empty; callers must
not let assembly failure abort the pause persist path.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.engine.segments import join_segments
from agentcore.runtime.events.sink import synthesize_required_marker
from agentcore.runtime.facts import TurnPausedFact, pre_pause_from_journal

logger = get_logger(__name__)

# ask_user absorbs same-round prose into the card — capture the pre-round bubble.
_ASK_USER_KIND = "ask_user"


def build_turn_paused_fact(
    *,
    checkpoint_id: str,
    suspension_kind: str,
    required_event: Any,
    journal_entries_before_trailing: list[dict[str, Any]],
    sink: Any | None,
) -> TurnPausedFact:
    """Assemble one ``TurnPausedFact`` from live capture inputs (G1–G5 / G7).

    ``journal_entries_before_trailing`` must be the fact-log snapshot **without**
    this pause's ``*_required`` / ``turn_paused`` trailing entries — multi-cycle
    inheritance reads the last prior ``turn_paused`` from it.
    """
    prior = pre_pause_from_journal(journal_entries_before_trailing)
    prior_content = prior.content if prior is not None else ""
    prior_reasoning = prior.reasoning if prior is not None else ""

    segment_content = _segment_content(suspension_kind)
    content = join_segments(prior_content, segment_content)

    live_reasoning = ""
    process: list[dict[str, Any]] = []
    run_processes: dict[str, list[dict[str, Any]]] = {}
    if sink is not None:
        try:
            live_reasoning = sink.streamed_reasoning() or ""
        except Exception:
            logger.warning(
                "turn_paused.streamed_reasoning_failed",
                checkpoint_id=checkpoint_id,
                exc_info=True,
            )
        try:
            process = list(sink.raw_process() or [])
            event_type = _event_type(required_event)
            payload = dict(getattr(required_event, "payload", None) or {})
            if event_type is not None:
                synthesize_required_marker(process, event_type, payload)
        except Exception:
            logger.warning(
                "turn_paused.process_capture_failed",
                checkpoint_id=checkpoint_id,
                exc_info=True,
            )
            process = []
        try:
            raw_runs = sink.raw_run_processes() or {}
            run_processes = {
                str(rid): list(steps) for rid, steps in raw_runs.items() if steps
            }
        except Exception:
            logger.warning(
                "turn_paused.run_processes_failed",
                checkpoint_id=checkpoint_id,
                exc_info=True,
            )
            run_processes = {}

    reasoning = join_segments(prior_reasoning, live_reasoning)

    citations: list[dict[str, Any]] = []
    try:
        from agentcore.runtime.suspension import turn_citations

        citations = list(turn_citations.get() or [])
    except Exception:
        logger.warning(
            "turn_paused.citations_failed",
            checkpoint_id=checkpoint_id,
            exc_info=True,
        )

    controller = _controller_seed()

    return TurnPausedFact(
        checkpoint_id=checkpoint_id,
        suspension_kind=suspension_kind,
        content=content,
        reasoning=reasoning,
        process=process,
        run_processes=run_processes,
        citations=citations,
        controller=controller,
    )


def _segment_content(suspension_kind: str) -> str:
    """This pause's deliverable segment from the captain mirror (G4)."""
    try:
        from agentcore.runtime.engine.loop import current_captain_loop

        mirror = current_captain_loop.get()
    except Exception:
        logger.warning("turn_paused.mirror_read_failed", exc_info=True)
        return ""
    if mirror is None:
        return ""
    if suspension_kind == _ASK_USER_KIND:
        return mirror.content_before_round or ""
    return mirror.final_content or ""


def _controller_seed() -> dict[str, Any]:
    try:
        from agentcore.runtime.engine.loop import current_captain_loop

        mirror = current_captain_loop.get()
    except Exception:
        logger.warning("turn_paused.controller_read_failed", exc_info=True)
        return {}
    if mirror is None or mirror.controller is None:
        return {}
    try:
        return dict(mirror.controller.export_seed())
    except Exception:
        logger.warning("turn_paused.controller_export_failed", exc_info=True)
        return {}


def _event_type(required_event: Any) -> Any | None:
    t = getattr(required_event, "type", None)
    if t is None:
        return None
    return getattr(t, "value", t)
