"""Recovery snapshot includes in-process pending approvals."""

from __future__ import annotations

import pytest

from agentcore.api.routes.conversations.turns import _pending_approval_summaries
from agentcore.runtime.interaction import InteractionKind, InteractionRegistry


@pytest.fixture
def registry() -> InteractionRegistry:
    return InteractionRegistry()


@pytest.mark.asyncio
async def test_pending_approval_summaries_from_registry(registry: InteractionRegistry) -> None:
    registry.create(
        "call-1",
        "conv-a",
        kind=InteractionKind.APPROVAL,
        payload={
            "tool_call_id": "call-1",
            "tool_name": "file_write",
            "arguments": {"path": "/tmp/x.txt"},
        },
    )
    registry.create(
        "cp-1",
        "conv-a",
        kind=InteractionKind.ASK_USER,
        payload={"question": "hi"},
    )
    registry.create(
        "call-2",
        "conv-b",
        kind=InteractionKind.APPROVAL,
        payload={
            "tool_call_id": "call-2",
            "tool_name": "code_execute",
            "arguments": {"code": "print(1)"},
        },
    )

    import agentcore.api.routes.conversations.turns as turns_mod

    original = turns_mod.default_interaction_registry
    turns_mod.default_interaction_registry = lambda: registry  # type: ignore[assignment]
    try:
        summaries = _pending_approval_summaries("conv-a")
    finally:
        turns_mod.default_interaction_registry = original

    assert len(summaries) == 1
    s = summaries[0]
    assert s.approval_id == "call-1"
    assert s.conversation_id == "conv-a"
    assert s.tool_call_id == "call-1"
    assert s.tool_name == "file_write"
    assert s.arguments == {"path": "/tmp/x.txt"}
