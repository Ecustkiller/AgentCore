"""Integration tests for the re-attach stream endpoint (执行与请求解耦 C1 · slice 1b).

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers auth, ownership (IDOR), the 204 "nothing live" fallback, and the core
replay-then-tail behaviour against a stand-in detached run registered directly in
the ``TurnRunRegistry`` (the full SSE turn is exercised elsewhere) — so this
isolates the route + ``EventSink.take_over`` contract: a re-attaching client
replays the transcript so far, then follows new events live.
"""

import asyncio

import httpx
import pytest

from agentcore.runtime.events import EventSink, content_delta
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


async def _read_until(resp: httpx.Response, needle: str, timeout: float = 3.0) -> str:
    """Accumulate SSE lines until ``needle`` appears, or fail on timeout."""
    acc = ""
    lines = resp.aiter_lines()
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while needle not in acc:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise AssertionError(f"timed out waiting for {needle!r}; got: {acc!r}")
        line = await asyncio.wait_for(lines.__anext__(), timeout=remaining)
        acc += f"{line}\n"
    return acc


async def test_attach_requires_auth(client):
    cid = "00000000-0000-0000-0000-000000000000"
    assert (await client.get(f"/v1/conversations/{cid}/stream")).status_code == 401


async def test_attach_204_when_no_run(client, make_invite):
    code = await make_invite("INV-ATT1")
    await _register_and_login(client, code, "attachidle")
    conv = await _new_conversation(client, "idle")

    # No live run → 204, so the client falls back to the persisted transcript.
    r = await client.get(f"/v1/conversations/{conv}/stream")
    assert r.status_code == 204, r.text


async def test_attach_replays_history_then_tails(client, make_invite):
    code = await make_invite("INV-ATT2")
    await _register_and_login(client, code, "attachlive")
    conv = await _new_conversation(client, "live")

    # Stand-in detached run with some transcript already accumulated.
    sink = EventSink()
    sink.emit(content_delta("ALPHA"))  # emitted before any consumer → replayed
    task = asyncio.create_task(_never())
    turn_runs.register(conversation_id=conv, task=task, sink=sink)
    try:
        async with client.stream(
            "GET", f"/v1/conversations/{conv}/stream"
        ) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            # Replay: the pre-attach transcript arrives first.
            await _read_until(resp, "ALPHA")
            # Tail: an event emitted after re-attach streams live to this consumer.
            sink.emit(content_delta("BRAVO"))
            await _read_until(resp, "BRAVO")
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

    # Dropping the attach stream is a pure detach — it never cancelled the run via
    # this path (the registry slot was only cleared by our explicit cancel above).
    assert turn_runs.get(conv) is None


async def test_attach_rejects_non_owner(client, make_invite, new_client):
    code = await make_invite("INV-ATT3")
    await _register_and_login(client, code, "attachowner")
    conv = await _new_conversation(client, "mine")

    code2 = await make_invite("INV-ATT4")
    async with new_client() as other:
        await _register_and_login(other, code2, "attachintruder")
        assert (
            await other.get(f"/v1/conversations/{conv}/stream")
        ).status_code == 404
