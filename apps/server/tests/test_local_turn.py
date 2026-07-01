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
* a retried write-back whose rows already landed is an idempotent no-op.
"""

from types import SimpleNamespace

import pytest

from agentcore.conversation import local_turn as local_turn_mod
from agentcore.conversation.service import record_local_turn

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
):
    """Fake record_local_turn's DB collaborators, recording calls into ``events``.

    ``existing_ids`` seeds the rows ``get_by_id`` reports as already-persisted, so the
    idempotency fast path (a retried write-back whose rows already landed) is exercised
    without a database. A ``CostEventRepository`` spy is wired so any (forbidden) ledger
    write surfaces as a ``("cost", …)`` event the content-only tests assert absent.
    """
    seeded = existing_ids or set()

    class _FakeMsgRepo:
        def __init__(self, _session):
            pass

        async def create(self, **kw):
            role = kw.get("role")
            events.append(("msg", role, kw.get("conversation_id")))
            # Separate entry so tests can assert the row was pinned to the client id
            # (the idempotency anchor) without disturbing the ("msg", …) membership checks.
            events.append(("msg_id", role, kw.get("message_id")))
            # The assistant row's trace_id (trace 链路): the write-back reuses the
            # client-supplied id so the reply joins its reasoning logs (打通气泡↔日志).
            events.append(("trace", role, kw.get("trace_id")))
            return SimpleNamespace(id=f"{role}-id")

        async def get_by_id(self, message_id, *, conversation_id):
            if message_id in seeded:
                return SimpleNamespace(id=message_id, conversation_id=conversation_id)
            return None

    class _FakeCostRepo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            # A sidecar turn must NOT bill here (metered at the inference proxy). The spy
            # records any call so the content-only契约 tests can assert it never fires.
            events.append(("cost", kw.get("message_id"), len(kw.get("runs") or [])))
            return len(kw.get("runs") or [])

    class _FakeConvRepo:
        def __init__(self, _session):
            pass

        async def get_by_id_unscoped(self, _conversation_id):
            return SimpleNamespace(title=existing_title)

        async def update_title_unscoped(self, conversation_id, title):
            events.append(("title", conversation_id, title))

    async def _fake_journal(_session, **kw):
        events.append(("journal", kw.get("message_id")))

    monkeypatch.setattr(local_turn_mod, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(local_turn_mod, "MessageRepository", _FakeMsgRepo)
    monkeypatch.setattr(local_turn_mod, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(local_turn_mod, "persist_turn_journal", _fake_journal)
    monkeypatch.setattr(local_turn_mod, "schedule_consolidation", lambda _cid: None)
    # Title generation: skip the LLM. A fake provider satisfies the build/close
    # dance; _generate_title is stubbed to a fixed string.
    monkeypatch.setattr(
        local_turn_mod, "build_provider", lambda *_a, **_k: SimpleNamespace(close=_noop_close)
    )

    async def _fake_title(**_kw):
        return "本地回合标题"

    monkeypatch.setattr(local_turn_mod, "generate_title", _fake_title)


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

    # User + assistant rows persisted under the conversation.
    assert ("msg", "user", "c1") in events
    assert ("msg", "assistant", "c1") in events
    # The replay journal is recorded keyed by the assistant row id (§18.3 唯一事实源).
    assert ("journal", "assistant-id") in events
    # Content-only: no cost ledger is written (metered at the inference proxy).
    assert not any(e[0] == "cost" for e in events)
    # A title-less conversation gets one minted from this turn.
    assert ("title", "c1", "本地回合标题") in events
    # The desktop reconciles its optimistic bubbles against these.
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
        assistant_content="",  # tool-only / errored local turn
        user_message_id=_USER_MSG_ID,
        message_id="m2",
        trace_id=_TRACE,
    )

    # The user turn still lands; the empty assistant reply does not, so no journal either.
    assert ("msg", "user", "c1") in events
    assert not any(e[0] == "msg" and e[1] == "assistant" for e in events)
    assert not any(e[0] == "journal" for e in events)
    # An existing title is left untouched (idempotent-guarded).
    assert not any(e[0] == "title" for e in events)
    assert result["assistant_message_id"] is None
    assert result["title"] is None


async def test_record_local_turn_records_no_cost_ledger(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题")

    # The content-only契约: a sidecar turn's spend is metered at the cloud inference proxy
    # (Slice 4a), so the write-back must NEVER write a cost ledger row here — doing so
    # would double-bill. Content (assistant row + journal) still persists.
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

    assert ("msg", "assistant", "c1") in events
    assert ("journal", "assistant-id") in events
    assert not any(e[0] == "cost" for e in events)  # never billed on the write-back
    assert result["assistant_message_id"] == "assistant-id"


async def test_record_local_turn_pins_user_row_to_client_id(monkeypatch):
    """The user row is created WITH the client-minted ``user_message_id`` (the idempotency
    anchor) so a retry can detect the turn already landed (回写可靠性 §一.1)."""
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

    # The user row was pinned to the client id; the assistant row keeps the pipeline id.
    assert ("msg_id", "user", "u-bubble-1") in events
    assert ("msg_id", "assistant", "m9") in events


async def test_record_local_turn_reuses_client_trace_id(monkeypatch):
    """trace 链路 (打通气泡↔日志): the desktop mints one ``trace_id`` per local turn and
    stamps it on every cloud inference-proxy LLM call; the write-back must REUSE it (not
    mint a fresh one) so the persisted reply joins those reasoning logs as one trace."""
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

    # The assistant row carries the client's trace_id verbatim (not a server-minted one).
    assert ("trace", "assistant", "0123456789abcdef0123456789abcdef") in events


async def test_record_local_turn_retry_is_idempotent_noop(monkeypatch):
    """A retried write-back whose user row already landed creates NOTHING — it returns the
    persisted ids (+ current title) so the desktop reconciles against the same rows instead
    of duplicating the turn (回写可靠性 §一.1)."""
    events: list = []
    _patch_persistence(
        monkeypatch,
        events,
        existing_title="已有标题",
        existing_ids={"u-bubble-1", "m9"},  # user + assistant already persisted
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

    # Nothing re-created: no message inserts, no 落账, no journal, no title mint.
    assert not any(e[0] == "msg" for e in events)
    assert not any(e[0] == "cost" for e in events)
    assert not any(e[0] == "journal" for e in events)
    assert not any(e[0] == "title" for e in events)
    # The persisted ids come back so the optimistic bubbles reconcile (not a new turn).
    assert result["user_message_id"] == "u-bubble-1"
    assert result["assistant_message_id"] == "m9"
    assert result["title"] == "已有标题"
