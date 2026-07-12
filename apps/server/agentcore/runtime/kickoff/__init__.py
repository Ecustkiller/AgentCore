"""Orchestration-layer kickoff gate（开工卡）— shared by ``delegate`` and ``debate``.

Trigger rules live here once; each primitive builds a :class:`KickoffSummary` and
asks the gate whether to durable-pause before fan-out / moderator start.
"""

from __future__ import annotations

from agentcore.runtime.kickoff.gate import (
    needs_capability_auth,
    should_kickoff,
    should_preview_delegate_plan,
    skip_after_confirmed_ask,
)
from agentcore.runtime.kickoff.pause import await_kickoff, kickoff_tools
from agentcore.runtime.kickoff.summary import (
    KickoffPrimitive,
    KickoffSummary,
    debate_kickoff_summary,
    delegate_kickoff_summary,
)

__all__ = [
    "KickoffPrimitive",
    "KickoffSummary",
    "await_kickoff",
    "debate_kickoff_summary",
    "delegate_kickoff_summary",
    "kickoff_tools",
    "needs_capability_auth",
    "should_kickoff",
    "should_preview_delegate_plan",
    "skip_after_confirmed_ask",
]
