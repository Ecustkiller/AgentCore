"""Pending-interactions journal fold + recovery (提问确认交互统一 P1)."""

from __future__ import annotations

import pytest

from agentcore.runtime.journal.pending_interactions import (
    fold_interactions,
    fold_pending_interactions,
    unrecorded_hot_orphans,
)


def test_fold_pending_opens_on_required_closes_on_resolved() -> None:
    entries = [
        {
            "kind": "approval_required",
            "payload": {
                "approval_id": "a1",
                "conversation_id": "c",
                "tool_call_id": "a1",
                "tool_name": "write",
                "arguments": {},
            },
        },
        {
            "kind": "escalation_required",
            "payload": {
                "escalation_id": "e1",
                "run_id": "r1",
                "agent_id": "a",
                "question": "q",
                "assumption": "x",
                "awaiting": "user",
            },
        },
        {
            "kind": "approval_resolved",
            "payload": {"approval_id": "a1", "tool_call_id": "a1", "decision": "approve"},
        },
    ]
    pending = fold_pending_interactions(entries, message_id="msg-1")
    assert len(pending) == 1
    assert pending[0].kind == "escalation"
    assert pending[0].id == "e1"
    assert pending[0].message_id == "msg-1"
    assert pending[0].payload["question"] == "q"


def test_fold_pending_orphaned_closes() -> None:
    entries = [
        {
            "kind": "approval_required",
            "payload": {
                "approval_id": "d1",
                "conversation_id": "c",
                "tool_call_id": "tc1",
                "tool_name": "code_execute",
                "arguments": {},
            },
        },
        {
            "kind": "interaction_orphaned",
            "payload": {"interaction_id": "d1", "kind": "approval"},
        },
    ]
    assert fold_pending_interactions(entries) == []


def test_fold_pending_skips_awaiting_ceo() -> None:
    entries = [
        {
            "kind": "escalation_required",
            "payload": {
                "escalation_id": "e-ceo",
                "run_id": "r",
                "agent_id": "a",
                "question": "q",
                "assumption": "x",
                "awaiting": "ceo",
            },
        },
    ]
    assert fold_pending_interactions(entries) == []


def _approval_required(iid: str = "a1") -> dict:
    return {
        "kind": "approval_required",
        "payload": {
            "approval_id": iid,
            "conversation_id": "c",
            "tool_call_id": iid,
            "tool_name": "file_delete",
            "arguments": {"permanent": True},
        },
    }


def test_fold_turn_end_orphans_hot_approval() -> None:
    """Interrupted write-back: leftover hot card is orphaned without an explicit fact."""
    entries = [
        _approval_required(),
        {"kind": "turn_end", "payload": {"finish_reason": "interrupted"}},
    ]
    recs = fold_interactions(entries)
    assert len(recs) == 1
    assert recs[0].kind == "approval"
    assert recs[0].id == "a1"
    assert recs[0].status == "orphaned"
    assert fold_pending_interactions(entries) == []
    assert unrecorded_hot_orphans(entries) == [("a1", "approval")]


def test_fold_message_end_interrupted_orphans_hot() -> None:
    entries = [
        _approval_required(),
        {"kind": "message_end", "payload": {"finish_reason": "interrupted"}},
    ]
    recs = fold_interactions(entries)
    assert recs[0].status == "orphaned"
    assert fold_pending_interactions(entries) == []


def test_fold_resolved_then_turn_end_stays_resolved() -> None:
    entries = [
        _approval_required(),
        {
            "kind": "approval_resolved",
            "payload": {"approval_id": "a1", "tool_call_id": "a1", "decision": "approve"},
        },
        {"kind": "turn_end", "payload": {"finish_reason": "end_turn"}},
    ]
    recs = fold_interactions(entries)
    assert recs[0].status == "resolved"
    assert unrecorded_hot_orphans(entries) == []


def test_fold_no_turn_end_keeps_hot_pending() -> None:
    entries = [_approval_required()]
    recs = fold_interactions(entries)
    assert recs[0].status == "pending"
    assert fold_pending_interactions(entries)[0].id == "a1"
    assert unrecorded_hot_orphans(entries) == []


def test_fold_ask_user_turn_end_does_not_orphan_cold() -> None:
    entries = [
        {
            "kind": "checkpoint_required",
            "payload": {
                "checkpoint_id": "cp1",
                "conversation_id": "c",
                "question": "继续吗？",
            },
        },
        {"kind": "turn_end", "payload": {"finish_reason": "interrupted"}},
    ]
    recs = fold_interactions(entries)
    assert recs[0].kind == "ask_user"
    assert recs[0].status == "pending"
    assert unrecorded_hot_orphans(entries) == []


def test_fold_message_end_paused_keeps_hot_pending() -> None:
    entries = [
        _approval_required(),
        {"kind": "message_end", "payload": {"finish_reason": "paused"}},
    ]
    recs = fold_interactions(entries)
    assert recs[0].status == "pending"
    assert fold_pending_interactions(entries)[0].id == "a1"
    assert unrecorded_hot_orphans(entries) == []


def test_unrecorded_hot_orphans_skips_explicit_fact() -> None:
    entries = [
        _approval_required(),
        {
            "kind": "interaction_orphaned",
            "payload": {"interaction_id": "a1", "kind": "approval"},
        },
        {"kind": "turn_end", "payload": {"finish_reason": "interrupted"}},
    ]
    recs = fold_interactions(entries)
    assert recs[0].status == "orphaned"
    assert unrecorded_hot_orphans(entries) == []


def test_append_unrecorded_hot_orphan_facts_after_interrupted_turn_end() -> None:
    """Salvage closer: leftover file_delete approval becomes an explicit journal fact."""
    from agentcore.runtime.journal.pending_interactions import (
        append_unrecorded_hot_orphan_facts,
    )

    entries = [
        _approval_required(),
        {"kind": "turn_end", "payload": {"finish_reason": "interrupted"}, "seq": 1},
    ]
    out = append_unrecorded_hot_orphan_facts(entries)
    kinds = [e.get("kind") for e in out]
    assert kinds[-1] == "interaction_orphaned"
    assert out[-1]["payload"] == {"interaction_id": "a1", "kind": "approval"}
    assert unrecorded_hot_orphans(out) == []
    assert append_unrecorded_hot_orphan_facts(out) == out


def test_append_unrecorded_hot_orphan_facts_noop_without_terminal() -> None:
    from agentcore.runtime.journal.pending_interactions import (
        append_unrecorded_hot_orphan_facts,
    )

    entries = [_approval_required()]
    assert append_unrecorded_hot_orphan_facts(entries) == entries


@pytest.mark.asyncio
async def test_interaction_registry_timeout_none_waits() -> None:
    """timeout=None must not raise TimeoutError immediately."""
    import asyncio

    from agentcore.runtime.interaction import InteractionKind, InteractionRegistry

    reg = InteractionRegistry()

    async def resolve_soon() -> None:
        await asyncio.sleep(0.05)
        reg.resolve("id-1", "ok", conversation_id="c")

    task = asyncio.create_task(resolve_soon())
    result = await reg.suspend(
        "id-1",
        "c",
        kind=InteractionKind.APPROVAL,
        payload={},
        timeout=None,
    )
    await task
    assert result == "ok"
