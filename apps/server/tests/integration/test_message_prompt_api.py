"""End-to-end API tests for GET /v1/conversations/{id}/messages/{mid}/prompt.

提示词透明 L3: a turn's verbatim system prompt, read back from the turn journal's
``turn_started`` head fact. Covers the happy path, the 404s (no journal / user message),
auth gating, and the conversation-scoped IDOR guard (a foreign message_id can't leak
another conversation's prompt).
"""

import httpx

from agentcore.db.models import Message
from agentcore.db.repositories import TurnJournalRepository
from agentcore.runtime.facts import FactKind

_PW = "password123"


async def _register_and_login(
    client: httpx.AsyncClient, invite_code: str, username: str
) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        "/v1/auth/login", json={"username": username, "password": _PW}
    )
    assert r.status_code == 200, r.text


async def _new_conversation(client: httpx.AsyncClient, title: str) -> str:
    r = await client.post("/v1/conversations", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _seed_assistant_turn(
    session_factory, conversation_id: str, system_prompt: str
) -> str:
    """Insert an assistant message + its turn_journal head fact; return the message id."""
    async with session_factory() as session:
        msg = Message(
            conversation_id=conversation_id, role="assistant", content="回答"
        )
        session.add(msg)
        await session.flush()
        message_id = msg.id
        await TurnJournalRepository(session).record(
            turn_id=message_id,
            conversation_id=conversation_id,
            trace_id=None,
            entries=[
                {
                    "kind": FactKind.TURN_STARTED.value,
                    "payload": {
                        "system_prompt": system_prompt,
                        "user_message": "问题",
                        "history_len": 0,
                    },
                    "ts": None,
                }
            ],
        )
    return message_id


async def test_message_prompt_requires_auth(client, new_client, make_invite):
    code = await make_invite("INV-MP-0")
    await _register_and_login(client, code, "mpauth")
    conv_id = await _new_conversation(client, "x")
    async with new_client() as anon:
        r = await anon.get(f"/v1/conversations/{conv_id}/messages/mid/prompt")
    assert r.status_code == 401


async def test_message_prompt_returns_verbatim_system_prompt(
    client, make_invite, session_factory
):
    code = await make_invite("INV-MP-1")
    await _register_and_login(client, code, "mpok")
    conv_id = await _new_conversation(client, "提示词透明")
    prompt = "你是 AgentCore 的 CEO……（本回合的逐字系统提示词）"
    mid = await _seed_assistant_turn(session_factory, conv_id, prompt)

    r = await client.get(f"/v1/conversations/{conv_id}/messages/{mid}/prompt")
    assert r.status_code == 200, r.text
    assert r.json()["system_prompt"] == prompt


async def test_message_prompt_404_without_journal(
    client, make_invite, session_factory
):
    code = await make_invite("INV-MP-2")
    await _register_and_login(client, code, "mpnone")
    conv_id = await _new_conversation(client, "无日志")
    # A bare assistant message with no turn_journal (e.g. a legacy turn).
    async with session_factory() as session:
        msg = Message(conversation_id=conv_id, role="assistant", content="x")
        session.add(msg)
        await session.flush()
        mid = msg.id
        await session.commit()

    r = await client.get(f"/v1/conversations/{conv_id}/messages/{mid}/prompt")
    assert r.status_code == 404


async def test_message_prompt_non_owner_404(
    client, new_client, make_invite, session_factory
):
    code = await make_invite("INV-MP-3")
    await _register_and_login(client, code, "mpowner")
    conv_id = await _new_conversation(client, "私密")
    mid = await _seed_assistant_turn(session_factory, conv_id, "私密提示词")

    code2 = await make_invite("INV-MP-3b")
    async with new_client() as other:
        await _register_and_login(other, code2, "mpintruder")
        r = await other.get(f"/v1/conversations/{conv_id}/messages/{mid}/prompt")
    assert r.status_code == 404


async def test_message_prompt_cross_conversation_idor_404(
    client, make_invite, session_factory
):
    """A turn_id from conversation A can't be read via conversation B you own."""
    code = await make_invite("INV-MP-4")
    await _register_and_login(client, code, "mpidor")
    conv_a = await _new_conversation(client, "A")
    conv_b = await _new_conversation(client, "B")
    mid = await _seed_assistant_turn(session_factory, conv_a, "A 的提示词")

    # Owned, but the message lives in conv_a — load_owned scopes by conversation.
    r = await client.get(f"/v1/conversations/{conv_b}/messages/{mid}/prompt")
    assert r.status_code == 404
    # Sanity: the correct pairing still works.
    r = await client.get(f"/v1/conversations/{conv_a}/messages/{mid}/prompt")
    assert r.status_code == 200, r.text
