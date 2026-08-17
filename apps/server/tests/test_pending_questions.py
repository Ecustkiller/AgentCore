"""Pending non-blocking questions: fold-backed CEO tail + 7-day journal sweep.

Ratchet for 定案 §二·④: scanning journals without fold would re-inject every
historical ``question_posted`` as still hanging. Injection must only keep pending.
"""

from __future__ import annotations

import pytest

from agentcore.conversation.pending_questions import (
    collect_pending_questions,
    pending_question_records,
    render_pending_questions,
)
from agentcore.conversation.question_retention import (
    TTL_DISCARD_NOTE,
    run_question_posted_retention_sweep,
)
from agentcore.runtime.journal.pending_interactions import InteractionRecord


def _posted(
    ask_id: str,
    *,
    question: str = "要 PDF 吗？",
    unlocks: str = "答案回来后出视觉稿",
    default: str = "Markdown",
) -> dict:
    return {
        "kind": "question_posted",
        "payload": {
            "ask_id": ask_id,
            "conversation_id": "c1",
            "question": question,
            "unlocks": unlocks,
            "questions": [{"id": "q1", "prompt": question, "kind": "text", "default": default}],
        },
    }


def _resolved(ask_id: str, *, status: str = "answered", answer: str = "也要", note: str = "") -> dict:
    return {
        "kind": "question_resolved",
        "payload": {"ask_id": ask_id, "status": status, "answer": answer, "note": note},
    }


def test_fold_pending_only_keeps_unsettled_questions():
    recs = pending_question_records(
        [_posted("old"), _resolved("old"), _posted("live")]
    )
    assert [r.id for r in recs] == ["live"]
    assert recs[0].status == "pending"


def test_historical_answered_question_is_not_injected():
    """§二·④: a prior-turn post that already settled must not come back as hanging."""
    journals = {
        "turn-old": [_posted("ask-old", question="去年那题"), _resolved("ask-old")],
        "turn-new": [_posted("ask-live", question="现在这题")],
    }
    items = collect_pending_questions(journals, ["turn-old", "turn-new"])
    assert [rec.id for _tid, rec in items] == ["ask-live"]
    text = render_pending_questions(items)
    assert "<pending_questions>" in text
    assert "ask-live" in text
    assert "现在这题" in text
    assert "ask-old" not in text
    assert "去年那题" not in text


def test_discarded_historical_question_is_not_injected():
    journals = {
        "turn-old": [
            _posted("ask-old"),
            _resolved("ask-old", status="discarded", answer="", note="按默认继续，后半等你。"),
        ]
    }
    items = collect_pending_questions(journals, ["turn-old"])
    assert items == []
    assert render_pending_questions(items) == ""


def test_one_shot_prior_turn_scan_without_fold_would_repeat():
    """Document the rejected shape: raw question_posted facts look 'open' forever."""
    prior_turn = [_posted("ask-old"), _resolved("ask-old"), _posted("ask-also-old")]
    raw_posts = [e for e in prior_turn if e["kind"] == "question_posted"]
    assert [e["payload"]["ask_id"] for e in raw_posts] == ["ask-old", "ask-also-old"]
    assert [r.id for r in pending_question_records(prior_turn)] == ["ask-also-old"]


def test_render_lists_every_pending_without_a_count_cap():
    items = [
        (
            "t1",
            InteractionRecord(
                kind="question_posted",
                id=f"ask-{i}",
                status="pending",
                payload={
                    "question": f"题{i}",
                    "unlocks": "后半",
                    "questions": [{"default": "A"}],
                },
            ),
        )
        for i in range(4)
    ]
    text = render_pending_questions(items)
    for i in range(4):
        assert f"ask-{i}" in text
        assert f"题{i}" in text


def test_render_empty_when_nothing_pending():
    assert render_pending_questions([]) == ""


@pytest.mark.asyncio
async def test_build_hint_uses_fold_across_hosts(monkeypatch):
    from agentcore.conversation import pending_questions as mod

    class _Repo:
        async def list_question_posted_hosts(self, **_kwargs):
            return [("c1", "turn-old"), ("c1", "turn-new")]

        async def load_map(self, turn_ids):
            assert turn_ids == ["turn-old", "turn-new"]
            return {
                "turn-old": [_posted("ask-old"), _resolved("ask-old")],
                "turn-new": [_posted("ask-live", question="还悬着")],
            }

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    monkeypatch.setattr("agentcore.db.base.async_session_factory", lambda: _Session())
    monkeypatch.setattr("agentcore.db.repositories.TurnJournalRepository", lambda _s: _Repo())

    text = await mod.build_pending_questions_hint(conversation_id="c1")
    assert "ask-live" in text
    assert "还悬着" in text
    assert "ask-old" not in text


@pytest.mark.asyncio
async def test_build_hint_empty_when_hosts_missing(monkeypatch):
    from agentcore.conversation import pending_questions as mod

    class _Repo:
        async def list_question_posted_hosts(self, **_kwargs):
            return []

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    monkeypatch.setattr("agentcore.db.base.async_session_factory", lambda: _Session())
    monkeypatch.setattr("agentcore.db.repositories.TurnJournalRepository", lambda _s: _Repo())
    assert await mod.build_pending_questions_hint(conversation_id="c1") == ""


@pytest.mark.asyncio
async def test_retention_sweep_discards_stale_pending_not_resolved(monkeypatch):
    from agentcore.conversation import question_retention as ret

    hosts = [("c1", "turn-old"), ("c1", "turn-fresh-resolved")]
    journals = {
        "turn-old": [_posted("ask-stale")],
        "turn-fresh-resolved": [_posted("ask-done"), _resolved("ask-done")],
    }
    settled: list[dict] = []

    class _Repo:
        async def list_question_posted_hosts(self, **_kwargs):
            return hosts

        async def load_map(self, turn_ids):
            return {tid: journals[tid] for tid in turn_ids}

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    async def _settle(**kwargs):
        settled.append(kwargs)
        return "settled"

    monkeypatch.setattr(ret, "async_session_factory", lambda: _Session())
    monkeypatch.setattr(ret, "TurnJournalRepository", lambda _s: _Repo())
    monkeypatch.setattr(ret, "settle_question_posted", _settle)

    n = await run_question_posted_retention_sweep()
    assert n == 1
    assert settled == [
        {
            "conversation_id": "c1",
            "ask_id": "ask-stale",
            "status": "discarded",
            "note": TTL_DISCARD_NOTE,
        }
    ]
    assert "不是按默认替你拍板" in TTL_DISCARD_NOTE
