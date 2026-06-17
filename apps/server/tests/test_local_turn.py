"""Unit tests for the sidecar local-turn write-back (双模式工作区 / 远期规划 §一.1).

``record_local_turn`` is the persistence + 计费回写 tail for a turn that ran on the
user's machine via the sidecar (no server SSE turn). It mirrors ``stream_chat``'s
tail — user row + assistant row + per-run 落账 + idempotent title — over a plain REST
call. All DB collaborators are faked (mirroring ``test_handoff_job``) so the control
flow is asserted without a database / LLM.

Covered:

* a full turn persists the user + assistant messages AND records the priced
  ``cost_runs`` ledger, returning the ids + the newly-minted title;
* an empty reply (tool-only / errored local turn) persists only the user row and
  records no cost / no assistant;
* a ledger write failure is swallowed (warning-only) — it must never break a turn
  whose reply already streamed on the user's machine.
"""

from types import SimpleNamespace

import pytest

from agentcore.conversation import service
from agentcore.conversation.service import record_local_turn

pytestmark = pytest.mark.anyio


class _FakeSession:
    async def rollback(self) -> None:  # used by the cost-ledger guard
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
    cost_raises: bool = False,
):
    """Fake record_local_turn's DB collaborators, recording calls into ``events``."""

    class _FakeMsgRepo:
        def __init__(self, _session):
            pass

        async def create(self, **kw):
            role = kw.get("role")
            events.append(("msg", role, kw.get("conversation_id")))
            return SimpleNamespace(id=f"{role}-id")

    class _FakeCostRepo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            if cost_raises:
                raise RuntimeError("ledger boom")
            events.append(("cost", kw.get("message_id"), len(kw.get("runs") or [])))
            return len(kw.get("runs") or [])

    class _FakeConvRepo:
        def __init__(self, _session):
            pass

        async def get_by_id(self, _conversation_id):
            return SimpleNamespace(title=existing_title)

        async def update_title(self, conversation_id, title):
            events.append(("title", conversation_id, title))

    async def _fake_journal(_session, **kw):
        events.append(("journal", kw.get("message_id")))

    monkeypatch.setattr(service, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(service, "MessageRepository", _FakeMsgRepo)
    monkeypatch.setattr(service, "CostEventRepository", _FakeCostRepo)
    monkeypatch.setattr(service, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(service, "persist_turn_journal", _fake_journal)
    monkeypatch.setattr(service, "schedule_consolidation", lambda _cid: None)
    # Title generation: skip the LLM. A fake provider satisfies the build/close
    # dance; _generate_title is stubbed to a fixed string.
    monkeypatch.setattr(
        service, "build_provider", lambda *_a, **_k: SimpleNamespace(close=_noop_close)
    )

    async def _fake_title(**_kw):
        return "本地回合标题"

    monkeypatch.setattr(service, "_generate_title", _fake_title)


async def _noop_close():
    return None


async def test_record_local_turn_persists_messages_and_cost(monkeypatch):
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
        cost_runs=[{"run_id": "r1", "role": "captain"}],
        message_id="m1",
        input_tokens=10,
        output_tokens=4,
        rounds=2,
    )

    # User + assistant rows persisted under the conversation.
    assert ("msg", "user", "c1") in events
    assert ("msg", "assistant", "c1") in events
    # The priced ledger is recorded under the SAME message_id (落账 lines up with the
    # assistant row), carrying the one run row.
    assert ("cost", "m1", 1) in events
    # A title-less conversation gets one minted from this turn.
    assert ("title", "c1", "本地回合标题") in events
    # The desktop reconciles its optimistic bubbles against these.
    assert result["user_message_id"] == "user-id"
    assert result["assistant_message_id"] == "assistant-id"
    assert result["title"] == "本地回合标题"


async def test_record_local_turn_empty_reply_skips_assistant_and_cost(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题")

    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="",  # tool-only / errored local turn
        cost_runs=[],
        message_id="m2",
    )

    # The user turn still lands; the empty assistant reply does not, and with no
    # cost_runs there is no 落账.
    assert ("msg", "user", "c1") in events
    assert not any(e[0] == "msg" and e[1] == "assistant" for e in events)
    assert not any(e[0] == "cost" for e in events)
    # An existing title is left untouched (idempotent-guarded).
    assert not any(e[0] == "title" for e in events)
    assert result["assistant_message_id"] is None
    assert result["title"] is None


async def test_record_local_turn_cost_failure_does_not_break_turn(monkeypatch):
    events: list = []
    _patch_persistence(monkeypatch, events, existing_title="已有标题", cost_raises=True)

    # A ledger write failure is swallowed (warning-only, 文档铁律): the reply already
    # streamed on the user's machine, so recording must never escape as an error.
    result = await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        cost_runs=[{"run_id": "r1"}],
        message_id="m3",
    )

    assert ("msg", "assistant", "c1") in events
    assert not any(e[0] == "cost" for e in events)  # the raising write recorded nothing
    assert result["assistant_message_id"] == "assistant-id"
