"""Orchestration-layer kickoff helpers — shared by ``delegate`` and ``debate``.

New ``team_preview`` / ``stage_card`` cards are not emitted. Frames whose
``kind`` is not a live :class:`~agentcore.runtime.suspension.SuspensionKind` are
skipped on list / hydrate (not restored). OpenAPI resolve does not accept
``kind=stage_card``.
"""

from __future__ import annotations

from agentcore.runtime.kickoff.debate_host import (
    DebateHostAttach,
    resolve_debate_host_attach,
)
from agentcore.runtime.kickoff.summary import (
    SESSION_DESK_LABEL,
    UNNAMED_DESK_LABEL,
    KickoffPrimitive,
    KickoffSummary,
    debate_kickoff_summary,
    delegate_kickoff_summary,
    enrich_worker_desk_names,
    format_kickoff_headline,
    intensity_short_label,
    worker_rows,
)

__all__ = [
    "DebateHostAttach",
    "KickoffPrimitive",
    "KickoffSummary",
    "SESSION_DESK_LABEL",
    "UNNAMED_DESK_LABEL",
    "debate_kickoff_summary",
    "delegate_kickoff_summary",
    "enrich_worker_desk_names",
    "format_kickoff_headline",
    "intensity_short_label",
    "worker_rows",
    "resolve_debate_host_attach",
]
