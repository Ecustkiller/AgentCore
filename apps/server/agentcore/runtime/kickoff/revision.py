"""Derive kickoff-card revision state from this turn's journal facts.

Not a loop state machine: walk ``team_preview_*`` facts already on the turn.
An ``adjust`` is **unfulfilled** until a later ``team_preview_required`` is
emitted (the revised card). Never-adjust turns stay untouched.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.facts import current_fact_log

_REQUIRED = "team_preview_required"
_RESOLVED = "team_preview_resolved"


@dataclass(frozen=True, slots=True)
class KickoffAdjustState:
    """Next-card lineage implied by the current journal suffix.

    ``unfulfilled``: a settled adjust has not yet been followed by a new card.
    When False, ``revision`` is 1 and lineage fields are empty (first card).
    """

    unfulfilled: bool
    revision: int = 1
    revised_from: str | None = None
    revision_note: str | None = None


def _entry_kind(entry: Mapping[str, Any]) -> str:
    return str(entry.get("kind") or entry.get("type") or "")


def _payload(entry: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = entry.get("payload")
    return raw if isinstance(raw, Mapping) else {}


def _revision_int(raw: Any) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 1
    return value if value >= 1 else 1


def kickoff_adjust_state(
    entries: Sequence[Mapping[str, Any]] | None,
) -> KickoffAdjustState:
    """Walk journal order; last ``team_preview_*`` fact decides fulfillment."""
    last_id: str | None = None
    last_rev = 1
    last_note: str | None = None
    unfulfilled = False
    for entry in entries or ():
        if not isinstance(entry, Mapping):
            continue
        kind = _entry_kind(entry)
        payload = _payload(entry)
        if kind == _REQUIRED:
            cid = str(payload.get("checkpoint_id") or "").strip()
            last_id = cid or last_id
            last_rev = _revision_int(payload.get("revision"))
            unfulfilled = False
        elif kind == _RESOLVED:
            raw = str(payload.get("decision") or "").strip().lower()
            if raw == CheckpointDecision.ADJUST.value:
                note = str(payload.get("note") or "").strip()
                last_note = note or None
                unfulfilled = True
    if not unfulfilled:
        return KickoffAdjustState(unfulfilled=False)
    return KickoffAdjustState(
        unfulfilled=True,
        revision=(last_rev + 1) if last_id else 2,
        revised_from=last_id,
        revision_note=last_note,
    )


def has_unfulfilled_kickoff_adjust(
    entries: Sequence[Mapping[str, Any]] | None,
) -> bool:
    """True when this turn has a settled adjust not yet followed by a new card."""
    return kickoff_adjust_state(entries).unfulfilled


def _has_team_preview_facts(entries: Sequence[Mapping[str, Any]]) -> bool:
    return any(_entry_kind(e) in {_REQUIRED, _RESOLVED} for e in entries if isinstance(e, Mapping))


def kickoff_turn_journal(*, sink: Any | None = None) -> Sequence[Mapping[str, Any]]:
    """This-turn kickoff facts: prefer ``current_fact_log``, else sink journal.

    Fact log is the resume-authoritative stream (inherited ``*_resolved`` after
    claim). Tests that only ``seed_journal`` still work via the sink fallback.
    """
    log = current_fact_log.get()
    fact_entries = list(log.entries()) if log is not None else []
    sink_entries: list[Mapping[str, Any]] = []
    if sink is not None:
        raw = sink.execution_journal() if hasattr(sink, "execution_journal") else None
        if raw:
            sink_entries = [e for e in raw if isinstance(e, Mapping)]
    if _has_team_preview_facts(fact_entries):
        return fact_entries
    return sink_entries
