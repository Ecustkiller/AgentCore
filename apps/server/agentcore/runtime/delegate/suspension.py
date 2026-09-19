"""Leftover plan_review persist is a no-op (kind retired; resume 410)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan

DelegateTool = Any


def can_persist_suspension(tool: DelegateTool) -> bool:
    """plan_review frames are no longer persisted."""
    return False


async def persist_suspension(
    tool: DelegateTool,
    checkpoint_id,
    plan: RunPlan,
    completed,
    steps,
    pending,
    required_event,
    ceo_review=None,
) -> bool:
    """Retired: never persist a plan_review frame."""
    return False


async def drop_suspension(tool: DelegateTool) -> None:
    """No leftover plan_review frames are written."""
    return
