"""Pipeline finalize helpers: runs payload and durable journal entries."""

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
    entries_from_runs,
)

logger = get_logger(__name__)


def _build_runs_payload(sink: EventSink, finish: FinishReason) -> dict | None:
    """Assemble the assistant message's ``runs`` payload from the turn's sink.

    Carries two replay artifacts on one field: the multi-agent ``events`` journal
    (team graph) and the single-agent ``process`` timeline (inline 思考+工具面板).
    A turn is one OR the other — the journal is None unless it delegated/checkpointed,
    the process is None unless it was a tool-using single-agent turn — but the
    shared shape keeps one persistence + load path. Returns None when there is
    nothing to replay (a plain chat turn with neither)."""
    journal = sink.execution_journal()
    process = sink.process_timeline()
    # 上下文传递可视化 通道①: the CEO captain's received context is TURN-LEVEL (the chat
    # bubble, present even in a pure-chat turn). Carrying it makes a pure-chat turn's
    # payload non-None, so it persists a journal (otherwise None-gated) and replays the
    # captain context on reload — the worker-side context already rides ``events``.
    captain_context = sink.captain_context()
    if journal is None and process is None and captain_context is None:
        return None
    payload: dict[str, Any] = {
        "events": journal or [],
        "finish_reason": finish.value,
    }
    if process:
        payload["process"] = process
    if captain_context is not None:
        payload["captain_context"] = captain_context
    return payload


def _durable_journal_entries(
    fact_log: TurnFactLog, runs: dict[str, Any] | None
) -> list[dict[str, Any]] | None:
    """The §18.3 fact log composed into the turn's durable journal entries (or None).

    The fact log is the single ordered stream (execution facts interleaved with the
    forwarded display facts); the durable journal adds the display-only tail the log
    does not carry — the single-agent ``process`` timeline (a post-hoc display
    aggregate) + the closing ``turn_end`` — both read off the already-built ``runs``
    so the two stay consistent. ``runs.events`` is NOT re-appended: those display
    events already ride the fact log (ungated), and the read-side projection
    (:func:`~agentcore.runtime.journal.runs_from_entries`) re-gates them.

    Gated to ``runs`` non-None — the SAME turns that persisted a journal before — so a
    plain chat turn still writes nothing (storage + None-gate parity); resume / salvage
    / local-relay paths carry no fact log and fall back to the legacy ``runs`` flatten.
    """
    if runs is None:
        return None
    tail = entries_from_runs(
        {"process": runs.get("process"), "finish_reason": runs.get("finish_reason")}
    )
    return fact_log.entries() + tail
