"""question_posted 收口：工厂 / 校验 / 幂等 settle。"""

from __future__ import annotations

import pytest

from agentcore.conversation.question_resolve import (
    note_ask_reply_ingested,
    settle_question_posted,
    validate_question_settlement,
)
from agentcore.runtime.events import EventSink, question_resolved
from agentcore.runtime.events.payloads.interaction import QuestionResolvedPayload
from agentcore.runtime.events.types import EventType
from agentcore.runtime.journal.pending_interactions import InteractionRecord


def test_question_resolved_factory_answered() -> None:
    event = question_resolved(ask_id="ask1", status="answered", answer="也要 PDF。")
    assert event.type == EventType.QUESTION_RESOLVED
    QuestionResolvedPayload.model_validate(event.payload)
    assert event.payload["status"] == "answered"
    assert event.payload["answer"] == "也要 PDF。"
    assert event.payload["note"] == ""


def test_question_resolved_factory_discarded() -> None:
    event = question_resolved(
        ask_id="ask1", status="discarded", note="按默认继续，后半等你。"
    )
    QuestionResolvedPayload.model_validate(event.payload)
    assert event.payload["status"] == "discarded"
    assert event.payload["note"] == "按默认继续，后半等你。"


def test_question_resolved_factory_unknown_status_falls_to_discarded() -> None:
    event = question_resolved(ask_id="ask1", status="nope")
    assert event.payload["status"] == "discarded"


def test_validate_question_settlement() -> None:
    validate_question_settlement(status="answered", answer="ok")
    validate_question_settlement(status="discarded", note="后半等你")
    with pytest.raises(ValueError, match="answered"):
        validate_question_settlement(status="answered", answer="  ")
    with pytest.raises(ValueError, match="discarded"):
        validate_question_settlement(status="discarded", note="")
    with pytest.raises(ValueError, match="status"):
        validate_question_settlement(status="pending")


@pytest.mark.asyncio
async def test_settle_question_posted_writes_and_signals(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    rec = InteractionRecord(
        kind="question_posted",
        id="ask1",
        status="pending",
        payload={"ask_id": "ask1", "question": "q"},
    )
    captured: dict = {}

    async def _load(conversation_id: str, ask_id: str):
        assert conversation_id == "c1"
        assert ask_id == "ask1"
        return "turn_host", rec

    async def _prewrite(**kwargs):
        captured.update(kwargs)

    signals: list = []
    attention: list = []

    async def _attention(**kwargs):
        attention.append(kwargs)

    monkeypatch.setattr(mod, "load_question_posted", _load)
    monkeypatch.setattr(mod, "prewrite_settlement_direct", _prewrite)
    monkeypatch.setattr(mod, "already_settled_in_writer", lambda _event: False)
    monkeypatch.setattr(
        mod,
        "publish_conversation_signal",
        lambda cid, event, already_on_sink=None: signals.append((cid, event, already_on_sink)),
    )
    monkeypatch.setattr(
        "agentcore.attention.signal_question_posted_resolved", _attention
    )

    outcome = await settle_question_posted(
        conversation_id="c1",
        ask_id="ask1",
        status="answered",
        answer="也要 PDF。",
    )
    assert outcome == "settled"
    assert captured["turn_id"] == "turn_host"
    assert captured["conversation_id"] == "c1"
    assert captured["event"].type.value == "question_resolved"
    assert captured["event"].payload["status"] == "answered"
    assert captured["event"].payload["answer"] == "也要 PDF。"
    assert len(signals) == 1
    assert signals[0][0] == "c1"
    assert signals[0][2] is None
    assert attention == [
        {
            "conversation_id": "c1",
            "turn_id": "turn_host",
            "interaction_id": "ask1",
            "payload": rec.payload,
        }
    ]


@pytest.mark.asyncio
async def test_settle_question_posted_already_processed(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    rec = InteractionRecord(
        kind="question_posted",
        id="ask1",
        status="resolved",
        payload={"ask_id": "ask1"},
        resolution={"status": "answered", "answer": "先到先得", "note": ""},
    )

    async def _load(conversation_id: str, ask_id: str):
        return "turn_host", rec

    monkeypatch.setattr(mod, "load_question_posted", _load)
    outcome = await settle_question_posted(
        conversation_id="c1",
        ask_id="ask1",
        status="answered",
        answer="迟到的答复",
    )
    assert outcome == "already_processed"


@pytest.mark.asyncio
async def test_settle_question_posted_not_found(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    async def _load(conversation_id: str, ask_id: str):
        return None

    monkeypatch.setattr(mod, "load_question_posted", _load)
    outcome = await settle_question_posted(
        conversation_id="c1",
        ask_id="missing",
        status="answered",
        answer="x",
    )
    assert outcome == "not_found"


@pytest.mark.asyncio
async def test_settle_question_posted_emits_on_live_sink(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    rec = InteractionRecord(
        kind="question_posted",
        id="ask1",
        status="pending",
        payload={"ask_id": "ask1", "question": "q"},
    )
    hub: list = []

    async def _load(conversation_id: str, ask_id: str):
        return "turn_host", rec

    async def _prewrite(**_kwargs):
        return None

    async def _attention(**_kwargs):
        return None

    monkeypatch.setattr(mod, "load_question_posted", _load)
    monkeypatch.setattr(mod, "prewrite_settlement_direct", _prewrite)
    monkeypatch.setattr(mod, "already_settled_in_writer", lambda _event: False)
    monkeypatch.setattr(
        mod,
        "publish_conversation_signal",
        lambda cid, event, already_on_sink=None: hub.append((cid, event, already_on_sink)),
    )
    monkeypatch.setattr("agentcore.attention.signal_question_posted_resolved", _attention)

    sink = EventSink()
    outcome = await settle_question_posted(
        conversation_id="c1",
        ask_id="ask1",
        status="answered",
        answer="选 A",
        sink=sink,
    )
    assert outcome == "settled"
    resolved = [e for e in sink._history if e.type is EventType.QUESTION_RESOLVED]  # noqa: SLF001
    assert len(resolved) == 1
    assert resolved[0].payload["ask_id"] == "ask1"
    assert resolved[0].payload["status"] == "answered"
    assert resolved[0].payload["answer"] == "选 A"
    assert len(hub) == 1
    assert hub[0][0] == "c1"
    assert hub[0][2] is sink


@pytest.mark.asyncio
async def test_note_ask_reply_ingested_skips_blank_and_swallows(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    calls: list[dict] = []

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(mod, "settle_question_posted", _settle)

    await note_ask_reply_ingested(conversation_id="c1", ask_id=None, answer="选 A")
    await note_ask_reply_ingested(conversation_id="c1", ask_id="  ", answer="选 A")
    await note_ask_reply_ingested(conversation_id="c1", ask_id="ask1", answer="  ")
    assert calls == []

    await note_ask_reply_ingested(
        conversation_id="c1",
        ask_id="ask1",
        answer="  ",
        has_attachments=True,
    )
    assert calls == [
        {
            "conversation_id": "c1",
            "ask_id": "ask1",
            "status": "answered",
            "answer": "（附件）",
            "sink": None,
        }
    ]
    calls.clear()

    await note_ask_reply_ingested(
        conversation_id="c1",
        ask_id="ask1",
        answer="选 A",
        sink=None,
    )
    assert calls == [
        {
            "conversation_id": "c1",
            "ask_id": "ask1",
            "status": "answered",
            "answer": "选 A",
            "sink": None,
        }
    ]


@pytest.mark.asyncio
async def test_note_ask_reply_ingested_swallows_not_found_and_processed(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    async def _not_found(**_kwargs):
        return "not_found"

    monkeypatch.setattr(mod, "settle_question_posted", _not_found)
    await note_ask_reply_ingested(conversation_id="c1", ask_id="ask1", answer="选 A")

    async def _processed(**_kwargs):
        return "already_processed"

    monkeypatch.setattr(mod, "settle_question_posted", _processed)
    await note_ask_reply_ingested(conversation_id="c1", ask_id="ask1", answer="选 A")


@pytest.mark.asyncio
async def test_note_ask_reply_ingested_logs_other_failures(monkeypatch) -> None:
    from agentcore.conversation import question_resolve as mod

    async def _boom(**_kwargs):
        raise RuntimeError("db down")

    warnings: list[dict] = []

    def _warn(event, **kwargs):
        warnings.append({"event": event, **kwargs})

    monkeypatch.setattr(mod, "settle_question_posted", _boom)
    monkeypatch.setattr(mod.logger, "warning", _warn)
    await note_ask_reply_ingested(conversation_id="c1", ask_id="ask1", answer="选 A")
    assert warnings[0]["event"] == "question_posted.ingest_settle_failed"
    assert warnings[0]["ask_id"] == "ask1"


def test_is_abort_finish_reason() -> None:
    from agentcore.conversation.question_resolve import is_abort_finish_reason
    from agentcore.runtime.events import FinishReason

    assert is_abort_finish_reason("cancelled") is True
    assert is_abort_finish_reason(FinishReason.CANCELLED) is True
    assert is_abort_finish_reason("interrupted") is True
    assert is_abort_finish_reason("error") is False
    assert is_abort_finish_reason("paused") is False
    assert is_abort_finish_reason(None) is False


def test_collect_injected_ask_replies_last_status_wins() -> None:
    from agentcore.conversation.question_resolve import collect_injected_ask_replies
    from agentcore.runtime.events import user_interjection

    received = user_interjection(
        interjection_id="inj-1",
        execution_id="e1",
        content="选 A",
        status="received",
        ask_id="ask1",
    )
    injected = user_interjection(
        interjection_id="inj-1",
        execution_id="e1",
        content="选 A",
        status="injected",
        ask_id="ask1",
    )
    queued = user_interjection(
        interjection_id="inj-2",
        execution_id="e1",
        content="选 B",
        status="queued",
        ask_id="ask2",
    )
    assert collect_injected_ask_replies([received]) == []
    assert collect_injected_ask_replies([received, injected]) == [("ask1", "选 A")]
    assert collect_injected_ask_replies([injected, queued]) == [("ask1", "选 A")]
    att_only = user_interjection(
        interjection_id="inj-3",
        execution_id="e1",
        content="",
        status="injected",
        attachments=[{"name": "a.pdf", "path": "a.pdf"}],
        ask_id="ask3",
    )
    assert collect_injected_ask_replies([att_only]) == [("ask3", "（附件）")]
