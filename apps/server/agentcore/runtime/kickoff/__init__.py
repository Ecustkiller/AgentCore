"""Orchestration-layer kickoff gate（开工卡）— shared by ``delegate`` and ``debate``.

Trigger rules live here once; each primitive builds a :class:`KickoffSummary` and
asks the gate whether to durable-pause before fan-out / moderator start.
"""

from __future__ import annotations

from agentcore.runtime.kickoff.cancel_guidance import (
    KICKOFF_CANCEL_GUIDANCE,
    format_kickoff_cancel_result,
)
from agentcore.runtime.kickoff.debate_host import (
    DebateHostAttach,
    resolve_debate_host_attach,
)
from agentcore.runtime.kickoff.gate import (
    is_short_affirmation,
    needs_capability_auth,
    should_kickoff,
    should_preview_delegate_plan,
)
from agentcore.runtime.kickoff.pause import await_kickoff, kickoff_tools
from agentcore.runtime.kickoff.research_first import (
    research_first_tool_result,
    should_offer_research_first,
    should_recommend_research_first,
)
from agentcore.runtime.kickoff.stage_card import (
    apply_motion_override,
    build_stage_card_payload,
    clear_turn_keeps_stage_card,
    consume_mlr_preauth,
    discard_mlr_preauth,
    emit_stage_card_for_motion,
    grant_mlr_preauth,
    mark_turn_keeps_stage_card,
    turn_keeps_stage_card,
)
from agentcore.runtime.kickoff.summary import (
    KickoffPrimitive,
    KickoffSummary,
    debate_kickoff_summary,
    delegate_kickoff_summary,
    format_kickoff_headline,
    intensity_short_label,
)
from agentcore.runtime.kickoff.team_veto import (
    WriteCapabilityOverride,
    apply_team_preview_veto,
    should_apply_team_veto,
    validate_team_preview_veto,
    validate_team_preview_veto_workers,
)

__all__ = [
    "DebateHostAttach",
    "KickoffPrimitive",
    "KickoffSummary",
    "WriteCapabilityOverride",
    "apply_motion_override",
    "apply_team_preview_veto",
    "await_kickoff",
    "build_stage_card_payload",
    "clear_turn_keeps_stage_card",
    "consume_mlr_preauth",
    "debate_kickoff_summary",
    "delegate_kickoff_summary",
    "discard_mlr_preauth",
    "emit_stage_card_for_motion",
    "format_kickoff_headline",
    "grant_mlr_preauth",
    "format_kickoff_cancel_result",
    "intensity_short_label",
    "KICKOFF_CANCEL_GUIDANCE",
    "kickoff_tools",
    "mark_turn_keeps_stage_card",
    "needs_capability_auth",
    "is_short_affirmation",
    "research_first_tool_result",
    "resolve_debate_host_attach",
    "should_apply_team_veto",
    "should_kickoff",
    "should_offer_research_first",
    "should_preview_delegate_plan",
    "should_recommend_research_first",
    "turn_keeps_stage_card",
    "validate_team_preview_veto",
    "validate_team_preview_veto_workers",
]
