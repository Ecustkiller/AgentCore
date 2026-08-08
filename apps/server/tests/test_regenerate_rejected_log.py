"""regenerate 早退拒绝须落库（chat.regenerate_rejected），便于排前端传错 id。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import agentcore.conversation.turns as turns_mod
from agentcore.api.sse import EventSink


class _FakeSessionCM:
    async def __aenter__(self):
        return SimpleNamespace(expire_all=lambda: None, commit=AsyncMock())

    async def __aexit__(self, *_a):
        return False


@pytest.mark.asyncio
async def test_regenerate_rejects_non_user_message_and_logs(monkeypatch):
    warnings: list[tuple[str, dict]] = []

    def _capture(event: str, **kwargs):
        warnings.append((event, kwargs))

    class _ConvRepo:
        def __init__(self, _session):
            pass

        async def get_by_id_unscoped(self, _cid):
            return SimpleNamespace(title="t", folder_id=None)

    class _MsgRepo:
        def __init__(self, _session):
            pass

        async def get_by_id(self, _mid, conversation_id=None):
            return SimpleNamespace(id=_mid, role="assistant", created_at=None)

    monkeypatch.setattr(turns_mod, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(turns_mod, "ConversationRepository", _ConvRepo)
    monkeypatch.setattr(turns_mod, "MessageRepository", _MsgRepo)
    monkeypatch.setattr(turns_mod.logger, "warning", _capture)

    sink = EventSink()
    await turns_mod.regenerate_chat(
        conversation_id="c1",
        message_id="asst-1",
        user_id="u1",
        sink=sink,
    )

    assert any(e == "chat.regenerate_rejected" for e, _ in warnings)
    payload = next(kw for e, kw in warnings if e == "chat.regenerate_rejected")
    assert payload["reason"] == "not_user"
    assert payload["found_role"] == "assistant"
    assert payload["message_id"] == "asst-1"
    assert payload["conversation_id"] == "c1"


@pytest.mark.asyncio
async def test_regenerate_rejects_missing_message_and_logs(monkeypatch):
    warnings: list[tuple[str, dict]] = []

    def _capture(event: str, **kwargs):
        warnings.append((event, kwargs))

    class _ConvRepo:
        def __init__(self, _session):
            pass

        async def get_by_id_unscoped(self, _cid):
            return SimpleNamespace(title="t", folder_id=None)

    class _MsgRepo:
        def __init__(self, _session):
            pass

        async def get_by_id(self, _mid, conversation_id=None):
            return None

    monkeypatch.setattr(turns_mod, "async_session_factory", lambda: _FakeSessionCM())
    monkeypatch.setattr(turns_mod, "ConversationRepository", _ConvRepo)
    monkeypatch.setattr(turns_mod, "MessageRepository", _MsgRepo)
    monkeypatch.setattr(turns_mod.logger, "warning", _capture)

    sink = EventSink()
    await turns_mod.regenerate_chat(
        conversation_id="c1",
        message_id="ghost",
        user_id="u1",
        sink=sink,
    )

    payload = next(kw for e, kw in warnings if e == "chat.regenerate_rejected")
    assert payload["reason"] == "missing"
    assert payload["found_role"] is None
