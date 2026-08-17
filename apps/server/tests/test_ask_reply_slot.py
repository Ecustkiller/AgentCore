"""Return-path contract slot: inbound ask_id on both reply paths + queue snapshot."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from agentcore.api.schemas.messages import QueuedTurnItem, SendMessageRequest
from agentcore.conversation.ask_reply import format_ask_reply_prompt, normalize_ask_id
from agentcore.runtime.coordination.inject import format_coordination_events
from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
)
from agentcore.runtime.events import EventSink, EventType, question_posted, user_interjection
from agentcore.runtime.events.payloads.interaction import QuestionPostedPayload
from agentcore.runtime.events.payloads.run import UserInterjectionPayload
from agentcore.runtime.resolve.prepare import merge_attachment_and_mention_context
from agentcore.runtime.turn.queue import new_queued_turn, turn_queue
from agentcore.runtime.turn.runs import turn_runs
from agentcore.runtime.turn.steer import (
    _reset_for_tests as reset_steer,
)
from agentcore.runtime.turn.steer import (
    begin_accepting,
    drain_as_messages,
    drain_injected,
    end_accepting,
    format_steer_user_message,
    promote_leftovers_to_queue,
    try_enqueue,
)

_ASK = "11111111-1111-4111-8111-111111111111"


def test_send_message_request_ask_id_optional_and_blank_is_ordinary():
    plain = SendMessageRequest(content="hi", delivery="steer")
    assert plain.ask_id is None
    blank = SendMessageRequest(content="hi", delivery="queue", ask_id="  ")
    assert blank.ask_id is None
    tagged = SendMessageRequest(content="选 A", delivery="steer", ask_id=_ASK)
    assert tagged.ask_id == _ASK


def test_send_message_request_ask_id_too_long_rejected():
    with pytest.raises(ValidationError):
        SendMessageRequest(content="hi", delivery="steer", ask_id="x" * 65)


def test_normalize_ask_id_drops_blank_and_overlong():
    assert normalize_ask_id(None) is None
    assert normalize_ask_id("  ") is None
    assert normalize_ask_id(_ASK) == _ASK
    assert normalize_ask_id("x" * 65) is None


def test_format_ask_reply_prompt_omitted_when_unidentified():
    assert format_ask_reply_prompt(None) is None
    assert format_ask_reply_prompt("  ") is None
    block = format_ask_reply_prompt(_ASK)
    assert block is not None
    assert _ASK in block
    assert "<ask_reply" in block
    assert "普通消息" in block


def test_merge_context_without_ask_id_stays_byte_identical():
    att = "<attached_files>\nbody\n</attached_files>"
    assert merge_attachment_and_mention_context(att, None) == att
    assert merge_attachment_and_mention_context(att, None, ask_id=None) == att
    merged = merge_attachment_and_mention_context(att, None, ask_id=_ASK)
    assert merged is not None
    assert merged.startswith(att)
    assert _ASK in merged


def test_question_posted_unlocks_optional_on_wire():
    bare = question_posted(ask_id=_ASK, conversation_id="c1", question="q")
    QuestionPostedPayload.model_validate(bare.payload)
    assert "unlocks" not in bare.payload
    posted = question_posted(
        ask_id=_ASK,
        conversation_id="c1",
        question="q",
        unlocks="派设计师出视觉稿",
    )
    QuestionPostedPayload.model_validate(posted.payload)
    assert posted.payload["unlocks"] == "派设计师出视觉稿"


def test_user_interjection_ask_id_absent_when_unidentified():
    ev = user_interjection(
        interjection_id="inj-1",
        execution_id="exec-1",
        content="随便说一句",
        status="received",
    )
    UserInterjectionPayload.model_validate(ev.payload)
    assert "ask_id" not in ev.payload


def test_user_interjection_ask_id_matches_outbound():
    ev = user_interjection(
        interjection_id="inj-1",
        execution_id="exec-1",
        content="选 A",
        status="received",
        ask_id=_ASK,
    )
    UserInterjectionPayload.model_validate(ev.payload)
    assert ev.payload["ask_id"] == _ASK


def test_queued_turn_and_snapshot_preserve_ask_id():
    cid = "c-ask-snap"
    turn_queue.clear(cid)
    item = new_queued_turn(content="选 A", user_id="u1", ask_id=_ASK)
    turn_queue.enqueue(cid, item)
    pending = turn_queue.list_pending(cid)
    assert pending[0].ask_id == _ASK
    snap = turn_queue._items_of(cid)  # noqa: SLF001
    assert snap[0]["ask_id"] == _ASK
    row = QueuedTurnItem(
        queue_id=item.queue_id,
        content=item.content,
        position=1,
        ask_id=item.ask_id,
    )
    assert row.model_dump()["ask_id"] == _ASK
    legacy = QueuedTurnItem(queue_id="q2", content="plain", position=1)
    assert legacy.ask_id is None
    turn_queue.clear(cid)


def test_queued_turn_without_ask_id_still_enqueues():
    cid = "c-ask-plain"
    turn_queue.clear(cid)
    turn_queue.enqueue(cid, new_queued_turn(content="普通一句", user_id="u1"))
    snap = turn_queue._items_of(cid)  # noqa: SLF001
    assert "ask_id" not in snap[0]
    assert "attachments" not in snap[0]
    assert "agent_mentions" not in snap[0]
    turn_queue.clear(cid)


def test_queued_turn_and_snapshot_preserve_attachments_and_mentions():
    cid = "c-snap-att"
    turn_queue.clear(cid)
    attachments = [
        {
            "name": "brief.txt",
            "path": "attachments/brief.txt",
            "text": "brief body",
            "workspace_path": "attachments/brief.txt",
        }
    ]
    mentions = [{"agent_id": "agent_research", "role": "研究员"}]
    item = new_queued_turn(
        content="请按附件看",
        user_id="u1",
        attachments=attachments,
        agent_mentions=mentions,
        ask_id=_ASK,
    )
    turn_queue.enqueue(cid, item)
    snap = turn_queue._items_of(cid)  # noqa: SLF001
    assert snap[0]["attachments"] == attachments
    assert snap[0]["agent_mentions"] == mentions
    assert snap[0]["ask_id"] == _ASK
    row = QueuedTurnItem(
        queue_id=item.queue_id,
        content=item.content,
        position=1,
        attachments=item.attachments,
        agent_mentions=item.agent_mentions,
        ask_id=item.ask_id,
    )
    dumped = row.model_dump()
    assert dumped["attachments"][0]["name"] == "brief.txt"
    assert dumped["agent_mentions"] == mentions
    turn_queue.clear(cid)


def test_steer_inject_and_leftover_queue_keep_ask_id():
    reset_steer()
    cid = "c-ask-steer"
    turn_queue.clear(cid)
    begin_accepting(cid, execution_id="exec-ask")
    parked = try_enqueue(conversation_id=cid, content="选 A", ask_id=_ASK)
    assert parked is not None
    assert parked.ask_id == _ASK
    msgs = drain_as_messages(cid)
    assert len(msgs) == 1
    assert _ASK in (msgs[0].content or "")
    assert "<ask_reply" in (msgs[0].content or "")
    end_accepting(cid)

    begin_accepting(cid, execution_id="exec-ask")
    parked = try_enqueue(conversation_id=cid, content="选 B", ask_id=_ASK)
    leftovers = end_accepting(cid)
    assert promote_leftovers_to_queue(leftovers) == 1
    queued = turn_queue.pop_next(cid)
    assert queued is not None
    assert queued.ask_id == _ASK
    assert queued.content == "选 B"
    turn_queue.clear(cid)
    reset_steer()


def test_format_steer_without_ask_id_does_not_invent_one():
    text = format_steer_user_message("改用中文")
    assert "<ask_reply" not in text
    assert "改用中文" in text


def test_coordination_inject_carries_ask_id():
    session = CoordinationSession(
        execution_id="exec-ask",
        total_workers=1,
        conversation_id="c-ask",
    )
    session.stash_interjection("inj-1", {"content": "选 A", "ask_id": _ASK})
    brief = format_coordination_events(
        session,
        [
            CoordinationEvent(
                kind=CoordinationEventKind.USER_INTERJECTION,
                payload={
                    "interjection_id": "inj-1",
                    "content": "选 A",
                    "ask_id": _ASK,
                },
            )
        ],
    )
    assert _ASK in brief
    assert "选 A" in brief


def test_coordination_inject_without_ask_id_stays_ordinary():
    session = CoordinationSession(
        execution_id="exec-ask",
        total_workers=1,
        conversation_id="c-ask",
    )
    brief = format_coordination_events(
        session,
        [
            CoordinationEvent(
                kind=CoordinationEventKind.USER_INTERJECTION,
                payload={"interjection_id": "inj-1", "content": "普通插话"},
            )
        ],
    )
    assert "<ask_reply" not in brief
    assert "普通插话" in brief


async def _never() -> None:
    await asyncio.Future()


@pytest.mark.asyncio
async def test_steer_leftover_queued_event_keeps_ask_id():
    reset_steer()
    cid = "c-ask-leftover-sse"
    turn_queue.clear(cid)
    sink = EventSink()
    blocker = asyncio.create_task(_never())
    turn_runs.register(conversation_id=cid, task=blocker, sink=sink)
    try:
        begin_accepting(cid, execution_id="exec-ask")
        parked = try_enqueue(conversation_id=cid, content="选 A", ask_id=_ASK)
        leftovers = end_accepting(cid)
        assert promote_leftovers_to_queue(leftovers) == 1
        queued_ev = next(
            e
            for e in sink._history  # noqa: SLF001
            if e.type is EventType.USER_INTERJECTION and e.payload.get("status") == "queued"
        )
        assert queued_ev.payload["ask_id"] == _ASK
        assert parked is not None
        assert turn_queue.list_pending(cid)[0].ask_id == _ASK
    finally:
        turn_queue.clear(cid)
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker
        reset_steer()


@pytest.mark.asyncio
async def test_coord_fifo_enqueue_preserves_ask_id():
    from agentcore.runtime.coordination.interjections import enqueue_interjection_to_fifo

    cid = "c-coord-ask-fifo"
    turn_queue.clear(cid)
    session = CoordinationSession(
        execution_id="exec-ask",
        total_workers=1,
        conversation_id=cid,
    )
    sink = EventSink()
    blocker = asyncio.create_task(_never())
    turn_runs.register(conversation_id=cid, task=blocker, sink=sink)
    try:
        ok, _msg, _status = enqueue_interjection_to_fifo(
            session,
            "inj-ask",
            {
                "content": "选 A",
                "user_id": "u1",
                "conversation_id": cid,
                "ask_id": _ASK,
            },
            sink=sink,
        )
        assert ok is True
        pending = turn_queue.list_pending(cid)
        assert len(pending) == 1
        assert pending[0].ask_id == _ASK
        snap = turn_queue._items_of(cid)  # noqa: SLF001
        assert snap[0]["ask_id"] == _ASK
        queued_ev = next(
            e
            for e in sink._history  # noqa: SLF001
            if e.type is EventType.USER_INTERJECTION and e.payload.get("status") == "queued"
        )
        assert queued_ev.payload["ask_id"] == _ASK
    finally:
        turn_queue.clear(cid)
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker


class _FakeSessionCM:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False


def _patch_stream_chat_persist(monkeypatch, *, title: str | None = "t"):
    from agentcore.conversation import turns as turns_mod
    from agentcore.core.types import AutonomyPolicy, recipe_to_axes

    class _ConvRepo:
        def __init__(self, _session):
            pass

        async def get_by_id_unscoped(self, _cid):
            return SimpleNamespace(title=title, folder_id=None)

    class _MsgRepo:
        def __init__(self, _session):
            pass

        async def create(self, **_kwargs):
            return SimpleNamespace(id="um1")

    class _BoardRepo:
        def __init__(self, _session):
            pass

        async def get_by_conversation_id(self, *_a, **_k):
            return None

    monkeypatch.setattr(turns_mod, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(turns_mod, "ConversationRepository", _ConvRepo)
    monkeypatch.setattr(turns_mod, "MessageRepository", _MsgRepo)
    monkeypatch.setattr(turns_mod, "BoardRepository", _BoardRepo)
    monkeypatch.setattr(turns_mod, "resolve_local_binding", AsyncMock(return_value=None))
    monkeypatch.setattr(turns_mod, "resolve_profile_set", AsyncMock(return_value=None))
    monkeypatch.setattr(turns_mod, "resolve_memory_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(
        turns_mod,
        "resolve_permission_axes",
        AsyncMock(return_value=recipe_to_axes(AutonomyPolicy.LESS_INTERRUPT)),
    )
    monkeypatch.setattr(
        turns_mod,
        "build_turn_backend",
        AsyncMock(return_value=SimpleNamespace(location="server")),
    )
    monkeypatch.setattr(turns_mod, "persist_attachments", AsyncMock(return_value=[]))
    monkeypatch.setattr(turns_mod, "to_stored_metadata", lambda _a: [])
    monkeypatch.setattr(
        turns_mod,
        "load_chat_context",
        AsyncMock(return_value=[{"role": "user", "content": "hi"}]),
    )
    monkeypatch.setattr(turns_mod, "maybe_compact_near_ceiling", AsyncMock())
    monkeypatch.setattr(
        turns_mod, "resolve_conversation_history_access", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        turns_mod, "maybe_delete_zero_output_send", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(
        turns_mod,
        "run_and_persist",
        AsyncMock(return_value={"message_id": "a1", "content": "ok"}),
    )
    monkeypatch.setattr(turns_mod, "schedule_title_generation", lambda **_k: None)
    monkeypatch.setattr(
        "agentcore.runtime.coordination.await_live_detached_drive",
        AsyncMock(),
    )
    return turns_mod


@pytest.mark.asyncio
async def test_stream_chat_persist_ingest_settles_ask_reply(monkeypatch):
    turns_mod = _patch_stream_chat_persist(monkeypatch)
    order: list[str] = []
    ingested: list[dict] = []

    async def _run(**_kwargs):
        order.append("run")
        return {"message_id": "a1", "content": "ok"}

    async def _delete(**_kwargs):
        order.append("delete")
        return False

    async def _spy(**kwargs):
        order.append("settle")
        ingested.append(kwargs)

    monkeypatch.setattr(turns_mod, "run_and_persist", _run)
    monkeypatch.setattr(turns_mod, "maybe_delete_zero_output_send", _delete)
    monkeypatch.setattr(turns_mod, "note_ask_replies_for_committed_send", _spy)
    sink = EventSink()
    await turns_mod.stream_chat(
        conversation_id="c1",
        user_message="选 A",
        user_id="u1",
        sink=sink,
        ask_id=_ASK,
    )
    assert order == ["run", "delete", "settle"]
    assert len(ingested) == 1
    assert ingested[0]["conversation_id"] == "c1"
    assert ingested[0]["ask_id"] == _ASK
    assert ingested[0]["answer"] == "选 A"
    assert ingested[0]["sink"] is sink
    assert ingested[0]["has_attachments"] is False


@pytest.mark.asyncio
async def test_stream_chat_without_ask_id_does_not_settle(monkeypatch):
    turns_mod = _patch_stream_chat_persist(monkeypatch)
    calls: list[dict] = []

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _settle
    )
    await turns_mod.stream_chat(
        conversation_id="c1",
        user_message="普通一句",
        user_id="u1",
        sink=EventSink(),
    )
    assert calls == []


@pytest.mark.asyncio
async def test_stream_chat_ask_id_zero_output_rollback_does_not_settle(monkeypatch):
    """Cross-cut: ask_id answer + Class B empty fail must not close the hanging card."""
    from agentcore.conversation.zero_output_rollback import (
        should_delete_zero_output_send_result,
    )
    from agentcore.core.error_codes import ErrorCode
    from agentcore.runtime.events import user_interjection

    turns_mod = _patch_stream_chat_persist(monkeypatch)
    class_b = {
        "message_id": "a1",
        "content": "",
        "error_code": ErrorCode.LLM_RATE_LIMIT,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "journal_entries": [],
    }
    assert should_delete_zero_output_send_result(
        class_b, user_created_this_send=True
    )

    async def _run(**kwargs):
        kwargs["sink"].emit(
            user_interjection(
                interjection_id="inj-1",
                execution_id="e1",
                content="选 A",
                status="injected",
                ask_id=_ASK,
            )
        )
        return class_b

    async def _delete(**kwargs):
        return should_delete_zero_output_send_result(
            kwargs["result"],
            user_created_this_send=kwargs["user_created_this_send"],
        )

    calls: list[dict] = []

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(turns_mod, "run_and_persist", _run)
    monkeypatch.setattr(turns_mod, "maybe_delete_zero_output_send", _delete)
    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _settle
    )
    await turns_mod.stream_chat(
        conversation_id="c1",
        user_message="选 A",
        user_id="u1",
        sink=EventSink(),
        ask_id=_ASK,
    )
    assert calls == []


@pytest.mark.asyncio
async def test_stream_chat_abort_and_unsubmitted_failure_do_not_settle(monkeypatch):
    turns_mod = _patch_stream_chat_persist(monkeypatch)
    calls: list[dict] = []

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _settle
    )

    async def _cancel(**_kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(turns_mod, "run_and_persist", _cancel)
    with pytest.raises(asyncio.CancelledError):
        await turns_mod.stream_chat(
            conversation_id="c1",
            user_message="选 A",
            user_id="u1",
            sink=EventSink(),
            ask_id=_ASK,
        )
    assert calls == []

    async def _boom(**_kwargs):
        raise RuntimeError("unsubmitted")

    monkeypatch.setattr(turns_mod, "run_and_persist", _boom)
    await turns_mod.stream_chat(
        conversation_id="c1",
        user_message="选 A",
        user_id="u1",
        sink=EventSink(),
        ask_id=_ASK,
    )
    assert calls == []


@pytest.mark.asyncio
async def test_stream_chat_attachment_only_ask_reply_settles(monkeypatch):
    turns_mod = _patch_stream_chat_persist(monkeypatch)
    ingested: list[dict] = []

    async def _spy(**kwargs):
        ingested.append(kwargs)

    monkeypatch.setattr(
        turns_mod,
        "persist_attachments",
        AsyncMock(return_value=[{"name": "a.pdf"}]),
    )
    monkeypatch.setattr(turns_mod, "note_ask_replies_for_committed_send", _spy)
    await turns_mod.stream_chat(
        conversation_id="c1",
        user_message="  ",
        user_id="u1",
        sink=EventSink(),
        ask_id=_ASK,
        attachments=[{"name": "a.pdf", "path": "a.pdf"}],
    )
    assert ingested[0]["ask_id"] == _ASK
    assert ingested[0]["has_attachments"] is True


@pytest.mark.asyncio
async def test_stream_chat_injected_ask_reply_settles_after_commit(monkeypatch):
    from agentcore.runtime.events import user_interjection

    turns_mod = _patch_stream_chat_persist(monkeypatch)
    calls: list[dict] = []

    async def _run(**kwargs):
        kwargs["sink"].emit(
            user_interjection(
                interjection_id="inj-1",
                execution_id="e1",
                content="选 A",
                status="injected",
                ask_id=_ASK,
            )
        )
        return {"message_id": "a1", "content": "ok"}

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(turns_mod, "run_and_persist", _run)
    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _settle
    )
    await turns_mod.stream_chat(
        conversation_id="c1",
        user_message="普通一句",
        user_id="u1",
        sink=EventSink(),
    )
    assert len(calls) == 1
    assert calls[0]["ask_id"] == _ASK
    assert calls[0]["answer"] == "选 A"
    assert calls[0]["status"] == "answered"


@pytest.mark.asyncio
async def test_steer_injected_does_not_settle_until_host_commit(monkeypatch):
    reset_steer()
    cid = "c-ask-injected"
    calls: list[dict] = []

    async def _note(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.note_ask_reply_ingested", _note
    )
    begin_accepting(cid, execution_id="exec-ask")
    parked = try_enqueue(conversation_id=cid, content="选 A", ask_id=_ASK)
    assert parked is not None
    sink = EventSink()
    msgs = await drain_injected(cid, sink=sink, execution_id="exec-ask")
    assert len(msgs) == 1
    assert _ASK in (msgs[0].content or "")
    injected = next(
        e
        for e in sink._history  # noqa: SLF001
        if e.type is EventType.USER_INTERJECTION and e.payload.get("status") == "injected"
    )
    assert injected.payload["ask_id"] == _ASK
    assert calls == []
    reset_steer()


@pytest.mark.asyncio
async def test_coord_injected_does_not_settle_until_host_commit(monkeypatch):
    from agentcore.runtime.coordination.interjections import note_interjections_injected

    calls: list[dict] = []

    async def _note(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.note_ask_reply_ingested", _note
    )
    session = CoordinationSession(
        execution_id="exec-ask",
        total_workers=1,
        conversation_id="c-ask",
    )
    sink = EventSink()
    session.event_sink = sink
    session.stash_interjection("inj-1", {"content": "选 A", "ask_id": _ASK})
    await note_interjections_injected(
        session,
        [
            CoordinationEvent(
                kind=CoordinationEventKind.USER_INTERJECTION,
                payload={"interjection_id": "inj-1", "content": "选 A", "ask_id": _ASK},
            )
        ],
    )
    injected = next(
        e
        for e in sink._history  # noqa: SLF001
        if e.type is EventType.USER_INTERJECTION and e.payload.get("status") == "injected"
    )
    assert injected.payload["ask_id"] == _ASK
    assert calls == []


@pytest.mark.asyncio
async def test_enqueue_and_sync_drain_do_not_settle(monkeypatch):
    calls: list[dict] = []

    async def _note(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.note_ask_reply_ingested", _note
    )
    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _note
    )

    reset_steer()
    cid = "c-ask-enqueue"
    turn_queue.clear(cid)
    begin_accepting(cid, execution_id="exec-ask")
    parked = try_enqueue(conversation_id=cid, content="选 A", ask_id=_ASK)
    assert parked is not None
    msgs = drain_as_messages(cid)
    assert len(msgs) == 1
    leftovers = end_accepting(cid)
    assert leftovers == []

    from agentcore.runtime.coordination.interjections import enqueue_interjection_to_fifo

    session = CoordinationSession(
        execution_id="exec-ask",
        total_workers=1,
        conversation_id=cid,
    )
    sink = EventSink()
    blocker = asyncio.create_task(_never())
    turn_runs.register(conversation_id=cid, task=blocker, sink=sink)
    try:
        ok, _msg, _status = enqueue_interjection_to_fifo(
            session,
            "inj-ask",
            {
                "content": "选 B",
                "user_id": "u1",
                "conversation_id": cid,
                "ask_id": _ASK,
            },
            sink=sink,
        )
        assert ok is True
        assert calls == []
    finally:
        turn_queue.clear(cid)
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker
        reset_steer()


@pytest.mark.asyncio
async def test_record_local_turn_injected_ask_settles_after_commit(monkeypatch):
    from agentcore.conversation import local_turn as lt

    calls: list[dict] = []

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _settle
    )
    monkeypatch.setattr(
        lt,
        "get_cloud_store",
        lambda: SimpleNamespace(
            finalize=AsyncMock(
                return_value={
                    "user_message_id": "u1",
                    "assistant_message_id": "a1",
                    "title": None,
                    "followups": None,
                    "noop": False,
                }
            )
        ),
    )
    await lt.record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="选 A",
        assistant_content="ok",
        journal=[
            {
                "type": "user_interjection",
                "payload": {
                    "interjection_id": "inj-1",
                    "content": "选 A",
                    "status": "injected",
                    "ask_id": _ASK,
                },
            }
        ],
        user_message_id="u1",
        message_id="a1",
        trace_id="a" * 32,
        finish_reason="end_turn",
    )
    assert len(calls) == 1
    assert calls[0]["ask_id"] == _ASK
    assert calls[0]["answer"] == "选 A"


@pytest.mark.asyncio
async def test_record_local_turn_cancelled_does_not_settle(monkeypatch):
    from agentcore.conversation import local_turn as lt

    calls: list[dict] = []

    async def _settle(**kwargs):
        calls.append(kwargs)
        return "settled"

    monkeypatch.setattr(
        "agentcore.conversation.question_resolve.settle_question_posted", _settle
    )
    monkeypatch.setattr(
        lt,
        "get_cloud_store",
        lambda: SimpleNamespace(
            finalize=AsyncMock(
                return_value={
                    "user_message_id": "u1",
                    "assistant_message_id": "a1",
                    "title": None,
                    "followups": None,
                    "noop": False,
                }
            )
        ),
    )
    await lt.record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="选 A",
        assistant_content="",
        journal=[
            {
                "type": "user_interjection",
                "payload": {
                    "interjection_id": "inj-1",
                    "content": "选 A",
                    "status": "injected",
                    "ask_id": _ASK,
                },
            }
        ],
        user_message_id="u1",
        message_id="a1",
        trace_id="a" * 32,
        finish_reason="cancelled",
    )
    assert calls == []
