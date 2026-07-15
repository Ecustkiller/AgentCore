"""Pipeline finalize helpers: journal entries and display replay projection."""

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
)
from agentcore.runtime.facts import (
    TurnFactLog,
)
from agentcore.runtime.journal import (
    journal_entries_from_display_runs,
)

logger = get_logger(__name__)


def _should_persist_journal(sink: EventSink) -> bool:
    """True when this turn has replayable display surface (team graph / process / context)."""
    return not (
        sink.execution_journal() is None
        and sink.process_timeline() is None
        and sink.run_process_timelines() is None
        and sink.captain_context() is None
    )


def _build_runs_payload(sink: EventSink, finish: FinishReason) -> dict[str, Any] | None:
    """Assemble the client-facing ``runs`` replay payload from the turn's sink.

    Used only to project ``journal_entries`` back into the wire shape the desktop /
    sidecar forwards on local-turn write-back (:func:`runs_from_entries`). The pipeline
    result itself carries ``journal_entries`` only — not this dict.
    """
    if not _should_persist_journal(sink):
        return None
    journal = sink.execution_journal()
    process = sink.process_timeline()
    run_processes = sink.run_process_timelines()
    captain_context = sink.captain_context()
    payload: dict[str, Any] = {
        "events": journal or [],
        "finish_reason": finish.value,
    }
    if process:
        payload["process"] = process
    if run_processes:
        payload["run_processes"] = run_processes
    if captain_context is not None:
        payload["captain_context"] = captain_context
    return payload


def _journal_entries_for_turn(
    fact_log: TurnFactLog | None,
    *,
    sink: EventSink,
    finish: FinishReason,
) -> list[dict[str, Any]] | None:
    """Compose durable journal entries for a completed turn (or None when gated off).

    Fresh turns pass the engine ``fact_log`` (execution facts + forwarded display facts)
    plus the display-only tail (process + ``turn_end``) read off the sink. Resume /
    other paths without a fact log flatten the sink's display replay via
    :func:`journal_entries_from_display_runs`.
    """
    runs = _build_runs_payload(sink, finish)
    if runs is None:
        return None
    if fact_log is not None:
        tail = journal_entries_from_display_runs(
            {
                "process": runs.get("process"),
                "run_processes": runs.get("run_processes"),
                "finish_reason": runs.get("finish_reason"),
            }
        )
        return fact_log.entries() + (tail or [])
    return journal_entries_from_display_runs(runs)
