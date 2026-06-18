"""Integration tests for the explicit stop endpoint (执行与请求解耦 C1 · slice 1a).

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers auth, ownership (IDOR), and the idempotent stop of a tracked run — the run
itself is a stand-in detached task registered directly in the ``TurnRunRegistry``
(the full SSE turn is exercised elsewhere), so this isolates the route + registry
contract: a live run is cancelled and reported, an absent one returns false.
"""

import asyncio

import httpx
import pytest

from agentcore.runtime.events import EventSink
from agentcore.runtime.turn_runs import turn_runs

_PW = "password123"


async def _register_and_login(
    client: httpx.AsyncClient, invite_code: str, username: str
) -> str:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        "/v1/auth/login", json={"username": username, "password": _PW}
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _new_conversation(client: httpx.AsyncClient, title: str) -> str:
    r = await client.post("/v1/conversations", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _never() -> None:
    await asyncio.Event().wait()


async def test_stop_requires_auth(client):
    cid = "00000000-0000-0000-0000-000000000000"
    assert (await client.post(f"/v1/conversations/{cid}/stop")).status_code == 401


async def test_stop_idempotent_and_cancels_tracked_run(client, make_invite):
    code = await make_invite("INV-STOP1")
    await _register_and_login(client, code, "stopuser")
    conv = await _new_conversation(client, "stoppable")

    # Nothing running yet → idempotent false (a late click settles cleanly).
    r = await client.post(f"/v1/conversations/{conv}/stop")
    assert r.status_code == 200, r.text
    assert r.json() == {"stopped": False}

    # Register a stand-in detached run for this conversation, then stop it.
    task = asyncio.create_task(_never())
    turn_runs.register(conversation_id=conv, task=task, sink=EventSink())
    try:
        r = await client.post(f"/v1/conversations/{conv}/stop")
        assert r.status_code == 200, r.text
        assert r.json() == {"stopped": True}
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        if not task.done():
            task.cancel()

    # After it settled, the slot is cleared so a second stop is false again.
    await asyncio.sleep(0)
    r = await client.post(f"/v1/conversations/{conv}/stop")
    assert r.json() == {"stopped": False}


async def test_stop_rejects_non_owner(client, make_invite, new_client):
    code = await make_invite("INV-STOP2")
    await _register_and_login(client, code, "stopowner")
    conv = await _new_conversation(client, "mine")

    code2 = await make_invite("INV-STOP3")
    async with new_client() as other:
        await _register_and_login(other, code2, "stopintruder")
        # Not owned → 404 (mirrors the handoff IDOR contract).
        assert (
            await other.post(f"/v1/conversations/{conv}/stop")
        ).status_code == 404
