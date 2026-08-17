"""Pending-interactions journal fold + recovery (提问确认交互统一 P1)."""

from __future__ import annotations

import pytest

from agentcore.runtime.journal.pending_interactions import (
    fold_interactions,
    fold_pending_interactions,
    project_interaction_leaf,
)


def test_fold_pending_opens_on_required_closes_on_resolved() -> None:
    entries = [
        {
            "kind": "approval_required",
            "payload": {
                "approval_id": "a1",
                "conversation_id": "c",
                "tool_call_id": "a1",
                "tool_name": "file_write",
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
            "kind": "delegation_authorization_required",
            "payload": {
                "authorization_id": "d1",
                "conversation_id": "c",
                "execution_id": "ex",
                "workers": [],
                "tools": [],
            },
        },
        {
            "kind": "interaction_orphaned",
            "payload": {"interaction_id": "d1", "kind": "delegation_authorization"},
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


def _posted_entry(ask_id: str = "ask1") -> dict:
    return {
        "kind": "question_posted",
        "payload": {
            "ask_id": ask_id,
            "conversation_id": "c",
            "question": "要 PDF 吗？",
            "context": "默认 Markdown。",
        },
    }


def test_question_posted_fold_stays_pending_without_resolved() -> None:
    recs = fold_interactions([_posted_entry()])
    assert len(recs) == 1
    assert recs[0].kind == "question_posted"
    assert recs[0].status == "pending"
    leaf = project_interaction_leaf(recs[0])
    assert leaf == {
        "kind": "question_posted",
        "id": "ask1",
        "status": "pending",
        "question": "要 PDF 吗？",
        "context": "默认 Markdown。",
    }
    assert "settlement" not in leaf
    assert fold_pending_interactions([_posted_entry()]) == []


def test_question_posted_fold_answered() -> None:
    recs = fold_interactions(
        [
            _posted_entry(),
            {
                "kind": "question_resolved",
                "payload": {
                    "ask_id": "ask1",
                    "status": "answered",
                    "answer": "也要 PDF。",
                    "note": "",
                },
            },
        ]
    )
    assert recs[0].status == "resolved"
    leaf = project_interaction_leaf(recs[0])
    assert leaf["status"] == "resolved"
    assert leaf["settlement"] == "answered"
    assert leaf["answer"] == "也要 PDF。"
    assert "note" not in leaf


def test_question_posted_fold_discarded() -> None:
    recs = fold_interactions(
        [
            _posted_entry(),
            {
                "kind": "question_resolved",
                "payload": {
                    "ask_id": "ask1",
                    "status": "discarded",
                    "answer": "",
                    "note": "按默认继续，后半等你。",
                },
            },
        ]
    )
    assert recs[0].status == "resolved"
    leaf = project_interaction_leaf(recs[0])
    assert leaf["settlement"] == "discarded"
    assert leaf["note"] == "按默认继续，后半等你。"
    assert "answer" not in leaf


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
