"""Kickoff trigger rules — single copy for delegate + debate."""

from __future__ import annotations

from typing import Any

from agentcore.core.types import AutonomyPolicy


def should_preview_delegate_plan(plan: Any, *, finalize: bool) -> bool:
    """Whether the *plan half* of a delegate kickoff would show (ignores autonomy).

    Hang when ≥2 workers OR any debate-marked node. Skip single-worker + finalize
    (zero-friction solo path). Nested depth / resume / ask_user skip / full_auto
    are decided by :func:`should_kickoff` and the caller.
    """
    if len(plan.nodes) >= 2:
        return True
    if any(bool(n.stance) or int(n.round or 0) > 0 for n in plan.nodes):
        return True
    if len(plan.nodes) == 1 and finalize:
        return False
    return False


# Back-compat aliases used by tests / call sites.
should_preview_plan = should_preview_delegate_plan
should_preview = should_preview_delegate_plan


def needs_capability_auth(
    *,
    local_gate: bool,
    autonomy: AutonomyPolicy,
) -> bool:
    """Whether the capability-auth half of the kickoff applies.

    - ``always_ask``: no kickoff grant (every call prompts) → False
    - ``full_auto``: auto-grant without listing tools → False (handled silently)
    - ``first_grant`` + local gate: True (show tools / await grant-or-per-call)
    """
    if not local_gate:
        return False
    if autonomy is AutonomyPolicy.ALWAYS_ASK:
        return False
    return autonomy is not AutonomyPolicy.FULL_AUTO


def should_kickoff(
    *,
    plan_preview: bool,
    local_gate: bool,
    autonomy: AutonomyPolicy,
) -> bool:
    """Whether to durable-pause for the merged kickoff card.

    ``plan_preview`` is primitive-specific (delegate: :func:`should_preview_delegate_plan`;
    debate top-level: always True). ``full_auto`` releases the **plan half** as well
    as capability listing — neither primitive shows the card under full_auto.
    """
    if autonomy is AutonomyPolicy.FULL_AUTO:
        return False
    if plan_preview:
        return True
    return needs_capability_auth(local_gate=local_gate, autonomy=autonomy)


def skip_after_confirmed_ask(tool: Any) -> bool:
    """Skip kickoff when this CEO turn already settled a blocking ask_user (avoid dual cards).

    Non-blocking ``question_posted`` or no ask at all → still kickoff. Only a resolved
    blocking checkpoint in the turn journal (or live sink journal) counts.
    """
    journal = list(tool._sink.execution_journal() or [])
    return any(e.get("type") == "checkpoint_resolved" for e in journal)
