"""Unit tests for the sidecar local-turn write-back (双模式工作区 / 远期规划 §一.1).

``record_local_turn`` is the persistence tail for a turn that ran on the user's machine
via the sidecar (no server SSE turn). It mirrors ``stream_chat``'s tail — user row +
assistant row + turn journal + idempotent title — over a plain REST call.

计费是刻意不在此回写的（Slice 4a）：sidecar 的 LLM 调用在云推理代理 ``/v1/inference``
处**实时权威计量**，所以这条 write-back **只落内容、不落账**——客户端不上报台账，杜绝重复
计费。下列用例据此锁定「content-only」契约。所有 DB 协作者都被假化（镜像 ``test_handoff_job``），
无需数据库 / LLM 即可断言控制流。

Covered:

* a full turn persists the user + assistant messages AND the turn journal (keyed by the
  assistant row id), minting a title for a title-less conversation;
* an empty reply (tool-only / errored local turn) persists only the user row — no
  assistant row, no journal;
* **no cost ledger is ever written** (content-only 契约，防回归到重复计费)；
* the user row is pinned to the client-minted id (idempotency anchor) while the assistant
  row keeps the pipeline id;
* a retried write-back whose rows already landed is an idempotent no-op;
* ``finish_reason=paused`` upserts an assistant snapshot without title / consolidation;
* resume completion updates a paused snapshot in place;
* a re-pause write-back with a fresh client user id reuses the paired user row.
"""

from types import SimpleNamespace

import pytest

from agentcore.conversation import local_turn as local_turn_mod
from agentcore.conversation.service import record_local_turn
from agentcore.runtime.events import FinishReason

pytestmark = pytest.mark.anyio

_TRACE = "0123456789abcdef0123456789abcdef"
_USER_MSG_ID = "user-bubble-test"


class _FakeSession:
    async def rollback(self) -> None:
        pass


class _FakeSessionCM:
    async def __aenter__(self) -> _FakeSession:
        return _FakeSession()

    async def __aexit__(self, *_exc) -> bool:
        return False


def _patch_persistence(
    monkeypatch,
    events: list,
    *,
    existing_title: str | None = None,
    existing_ids: set[str] | None = None,
    existing_usage: dict[str, dict] | None = None,
    paired_user_by_assistant: dict[str, str] | None = None,
):
    """Fake record_local_turn's DB collaborators, recording calls into ``events``.

    ``existing_ids`` seeds the rows ``get_by_id`` reports as already-persisted, so the
    idempotency fast path (a retried write-back whose rows already landed) is exercised
    without a database. A ``CostEventRepository`` spy is wired so any (forbidden) ledger
    write surfaces as a ``("cost", …)`` event the content-only tests assert absent.
    """
    seeded = existing_ids or set()
    usage_by_id = existing_usage or {}
    paired_user_by_assistant: dict[str, str] = paired_user_by_assistant or {}

    class _FakeMsgRepo:
        def __init__(self, _session):
            pass

        async def create(self, **kw):
            role = kw.get("role")
            events.append(("msg", role, kw.get("conversation_id")))
            events.append(("msg_id", role, kw.get("message_id")))
            events.append(("trace", role, kw.get("trace_id")))
            return SimpleNamespace(id=f"{role}-id")

        async def upsert_assistant(self, **kw):
            events.append(("upsert", "assistant", kw.get("conversation_id")))
            events.append(("msg_id", "assistant", kw.get("message_id")))
            events.append(("trace", "assistant", kw.get("trace_id")))
            events.append(("usage", "assistant", kw.get("metadata")))
            return SimpleNamespace(id="assistant-id")

        async def get_by_id(self, message_id, *, conversation_id):
            if message_id in seeded:
                return SimpleNamespace(
                    id=message_id,
                    conversation_id=conversation_id,
                    role="assistant" if message_id.startswith("m") else "user",
                    usage=usage_by_id.get(message_id),
                )
            return None

        async def user_message_for_assistant(self, *, conversation_id, assistant_message_id):
            paired_id = paired_user_by_assistant.get(assistant_message_id)
            if not paired_id:
                return None
            return SimpleNamespace(
                id=paired_id,
                conversation_id=conversation_id,
                role="user",
                usage=None,
            )

    class _FakeCostRepo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            events.append(("cost", kw.get("message_id"), len(kw.get("runs") or [])))
            return len(kw.get("runs") or [])

    class _FakeConvRepo:
        def __init__(self, _session):
            pass

        async def get_by_id_unscoped(self, _conversation_id):
            return SimpleNamespace(title=existing_title)

        async def update_title_unscoped(self, conversation_id, title, *, tag=None):
            events.append(("title", conversation_id, title))

    async def _fake_journal(_session, **kw):
        events.append(("journal", kw.get("message_id")))

    consolidation_calls: list[str] = []

    monkeypatch.setattr(local_turn_mod, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(local_turn_mod, "MessageRepository", _FakeMsgRepo)
    monkeypatch.setattr(local_turn_mod, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(local_turn_mod, "persist_turn_journal", _fake_journal)
    monkeypatch.setattr(
        local_turn_mod,
        "schedule_consolidation",
        lambda cid: consolidation_calls.append(cid),
    )
    monkeypatch.setattr(
        local_turn_mod, "build_provider", lambda *_a, **_k: SimpleNamespace(close=_noop_close)
    )

    from agentcore.memory.conversation_title import TitleResult

    async def _fake_title(**_kw):
        return TitleResult(title="本地回合标题", tag="research")

    monkeypatch.setattr(local_turn_mod, "generate_title", _fake_title)
    return consolidation_calls


async def _noop_close():
    return None


async def test_record_local_turn_persists_messages_and_journal(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title=None)

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="列出本地文件",
        assistant_content="已列出。",
        assistant_reasoning="思考…",
        citations=[{"url": "https://x"}],
        runs={"events": [], "finish_reason": "end_turn"},
        user_message_id=_USER_MSG_ID,
        message_id="m1",
        input_tokens=10,
        output_tokens=4,
        rounds=2,
        trace_id=_TRACE,
    )

    assert ("msg", "user", "c1") in events
    assert ("upsert", "assistant", "c1") in events
    assert ("journal", "assistant-id") in events
    assert not any(e[0] == "cost" for e in events)
    assert ("title", "c1", "本地回合标题") in events
    assert result["user_message_id"] == "user-id"
    assert result["assistant_message_id"] == "assistant-id"
    assert result["title"] == "本地回合标题"


async def test_record_local_turn_empty_reply_skips_assistant_and_journal(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题")

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="",
        user_message_id=_USER_MSG_ID,
        message_id="m2",
        trace_id=_TRACE,
    )

    assert ("msg", "user", "c1") in events
    assert not any(e[0] == "upsert" for e in events)
    assert not any(e[0] == "journal" for e in events)
    assert not any(e[0] == "title" for e in events)
    assert result["assistant_message_id"] is None
    assert result["title"] is None


async def test_record_local_turn_records_no_cost_ledger(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题")

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        runs={"events": [], "finish_reason": "end_turn"},
        user_message_id=_USER_MSG_ID,
        message_id="m3",
        input_tokens=99,
        output_tokens=42,
        trace_id=_TRACE,
    )

    assert ("upsert", "assistant", "c1") in events
    assert ("journal", "assistant-id") in events
    assert not any(e[0] == "cost" for e in events)
    assert result["assistant_message_id"] == "assistant-id"


async def test_record_local_turn_pins_user_row_to_client_id(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题")

    await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        user_message_id="u-bubble-1",
        message_id="m9",
        trace_id=_TRACE,
    )

    assert ("msg_id", "user", "u-bubble-1") in events
    assert ("msg_id", "assistant", "m9") in events


async def test_record_local_turn_reuses_client_trace_id(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题")

    await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        user_message_id=_USER_MSG_ID,
        message_id="m1",
        trace_id="0123456789abcdef0123456789abcdef",
    )

    assert ("trace", "assistant", "0123456789abcdef0123456789abcdef") in events


async def test_record_local_turn_retry_is_idempotent_noop(monkeypatch):
    events: list = []
    _patch_persistence(
        monkeypatch,
        events,
        existing_title="已有标题",
        existing_ids={"u-bubble-1", "m9"},
    )

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        user_message_id="u-bubble-1",
        message_id="m9",
        trace_id=_TRACE,
    )

    assert not any(e[0] == "msg" for e in events)
    assert not any(e[0] == "upsert" for e in events)
    assert not any(e[0] == "cost" for e in events)
    assert not any(e[0] == "journal" for e in events)
    assert not any(e[0] == "title" for e in events)
    assert result["user_message_id"] == "u-bubble-1"
    assert result["assistant_message_id"] == "m9"
    assert result["title"] == "已有标题"


async def test_record_local_turn_paused_skips_title_and_consolidation(monkeypatch):
    events: list = []
    consolidation = _patch_persistence(monkeypatch, events, existing_title=None)

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="partial",
        user_message_id=_USER_MSG_ID,
        message_id="m-pause",
        trace_id=_TRACE,
        finish_reason=FinishReason.PAUSED.value,
    )

    assert ("msg", "user", "c1") in events
    assert ("upsert", "assistant", "c1") in events
    assert ("usage", "assistant", {"paused": True, "input_tokens": 0, "output_tokens": 0,
                                   "reasoning_tokens": 0, "cache_hit_tokens": 0,
                                   "cache_miss_tokens": 0, "rounds": 0}) in events
    assert not any(e[0] == "journal" for e in events)
    assert not any(e[0] == "title" for e in events)
    assert consolidation == []
    assert result["title"] is None


async def test_record_local_turn_resume_after_pause_updates_assistant(monkeypatch):
    events: list = []
    consolidation = _patch_persistence(
        monkeypatch,
        events,
        existing_title=None,
        existing_ids={_USER_MSG_ID, "m-pause"},
        existing_usage={"m-pause": {"paused": True}},
    )

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="done",
        runs={"events": [], "finish_reason": "end_turn"},
        user_message_id=_USER_MSG_ID,
        message_id="m-pause",
        trace_id=_TRACE,
        finish_reason=FinishReason.END_TURN.value,
    )

    assert not any(e[0] == "msg" for e in events)
    assert ("upsert", "assistant", "c1") in events
    assert ("journal", "assistant-id") in events
    assert ("title", "c1", "本地回合标题") in events
    assert consolidation == ["c1"]
    assert result["assistant_message_id"] == "assistant-id"


async def test_record_local_turn_repause_reuses_paired_user_row(monkeypatch):
    events: list = []
    _patch_persistence(
        monkeypatch,
        events,
        existing_title=None,
        existing_ids={"m-pause"},
        existing_usage={"m-pause": {"paused": True}},
        paired_user_by_assistant={"m-pause": _USER_MSG_ID},
    )

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="partial again",
        user_message_id="fresh-client-user-id",
        message_id="m-pause",
        trace_id=_TRACE,
        finish_reason=FinishReason.PAUSED.value,
    )

    assert not any(e[0] == "msg" for e in events)
    assert ("upsert", "assistant", "c1") in events
    assert result["user_message_id"] == _USER_MSG_ID
