"""计划复核已退役：fold 投影 skip；kind 不在 live resolve / SuspensionKind。"""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from agentcore.api.schemas.messages import ResolveInteractionRequest
from agentcore.runtime.journal.pending_interactions import (
    fold_interactions,
    fold_pending_interactions,
)
from agentcore.runtime.suspension import is_live_suspension_kind, suspension_from_json


def test_fold_skips_leftover_plan_review_and_recovery_pending_excludes_it():
    entries = [
        {
            "type": "plan_review_required",
            "payload": {
                "checkpoint_id": "cp_1",
                "conversation_id": "c",
                "steps": [{"run_id": "r1", "role": "调研", "summary": "方案就绪"}],
                "pending": [{"run_id": "r2", "role": "执行"}],
            },
        }
    ]
    pending = fold_pending_interactions(entries, message_id="m1")
    assert pending == []
    recs = fold_interactions(entries)
    assert recs == []


@pytest.mark.asyncio
async def test_resolve_interaction_rejects_plan_review_kind():
    with pytest.raises(ValidationError):
        TypeAdapter(ResolveInteractionRequest).validate_python(
            {"kind": "plan_review", "decision": "continue"}
        )


def test_leftover_plan_review_frame_is_unknown_kind():
    assert is_live_suspension_kind("plan_review") is False
    with pytest.raises(ValueError, match="unknown suspension kind"):
        suspension_from_json(
            {
                "kind": "plan_review",
                "message_id": "m1",
                "conversation_id": "c",
                "user_id": "u",
                "captain_run_id": "cap",
                "checkpoint_id": "cp1",
                "tool_call_id": "tc1",
                "base_system_prompt": "",
                "user_message": "go",
            }
        )
