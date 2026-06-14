"""Integration tests for the cost & usage observability endpoints.

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Seeds the ``cost_events`` ledger directly (the write path is covered by
test_cost_ledger.py) and exercises the three reads end-to-end: the team payroll
(``/messages/{id}/cost``), the conversation total (``/conversations/{id}/cost``),
and the account dashboard (``/usage/summary``) — including auth + IDOR scoping.
"""

import httpx

from agentcore.core.types import new_id
from agentcore.db.repositories import ConversationRepository, CostEventRepository

_PW = "password123"


async def _register_and_login(
    client: httpx.AsyncClient, invite_code: str, username: str
) -> str:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/v1/auth/login", json={"username": username, "password": _PW})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _run(
    run_id: str,
    *,
    role: str = "member",
    parent: str | None = None,
    model: str = "deepseek-v4-pro",
    total: int = 1000,
) -> dict:
    """A per-run ledger payload in the runtime's ``asdict(RunCost)`` shape."""
    return {
        "run_id": run_id,
        "parent_run_id": parent,
        "agent_id": run_id,
        "role": role,
        "model": model,
        "tokens": {"input": 100, "output": 50, "reasoning": 10, "cache_hit": 60, "cache_miss": 40},
        "cost": {"input": 800, "cached": 100, "output": 200, "total": total},
        "cost_total_nano": total,
        "currency": "USD",
        "rounds": 2,
        "duration_ms": 500,
    }


async def test_usage_endpoints_require_auth(client):
    assert (await client.get("/v1/usage/summary")).status_code == 401
    assert (await client.get(f"/v1/messages/{new_id()}/cost")).status_code == 401
    assert (
        await client.get(f"/v1/conversations/{new_id()}/cost")
    ).status_code == 401


async def test_message_cost_returns_payroll_and_turn_total(
    client, make_invite, session_factory
):
    code = await make_invite("INV-PAYROLL")
    user_id = await _register_and_login(client, code, "payrolluser")

    conv_id, msg_id = new_id(), new_id()
    cap_id, mem_id = new_id(), new_id()
    async with session_factory() as session:
        await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=conv_id,
            message_id=msg_id,
            runs=[
                _run(cap_id, role="captain", model="deepseek-v4-flash", total=300),
                _run(mem_id, parent=cap_id, total=1200),
            ],
        )

    r = await client.get(f"/v1/messages/{msg_id}/cost")
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["message_id"] == msg_id
    assert len(body["agents"]) == 2
    # Captain first (written first, ordered created_at asc).
    assert body["agents"][0]["role"] == "captain"
    assert body["agents"][1]["role"] == "member"
    # Turn total = sum of the two priced rows; rounds summed.
    assert body["cost"]["total"] == 1500
    assert body["cost"]["input"] == 1600
    assert body["cost"]["currency"] == "USD"
    assert body["rounds"] == 4
    # Display CNY rides along (7.2 rate by default): 1500 nano-USD → tiny, rounds
    # to 0.00 元 but the field is present and a float.
    assert isinstance(body["cost"]["cny_total"], float)
    # Usage rolled up from both rows (short ledger keys).
    assert body["usage"]["input"] == 200
    assert body["usage"]["cache_hit"] == 120


async def test_message_cost_is_user_scoped(client, make_invite, session_factory, new_client):
    # A second user must never see the first user's payroll (IDOR): the query is
    # scoped by user_id, so a non-owner gets zeros + an empty roster (no leak).
    code = await make_invite("INV-SCOPE")
    owner_id = await _register_and_login(client, code, "owneru")

    msg_id = new_id()
    async with session_factory() as session:
        await CostEventRepository(session).record_runs(
            user_id=owner_id,
            conversation_id=new_id(),
            message_id=msg_id,
            runs=[_run(new_id(), role="captain", total=500)],
        )

    code2 = await make_invite("INV-SCOPE-2")
    async with new_client() as other:
        await _register_and_login(other, code2, "otheru")
        r = await other.get(f"/v1/messages/{msg_id}/cost")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["agents"] == []
    assert body["cost"]["total"] == 0


async def test_conversation_cost_totals_and_ownership(
    client, make_invite, session_factory, new_client
):
    code = await make_invite("INV-CONV")
    user_id = await _register_and_login(client, code, "convuser")

    # Own the conversation so the read passes the ownership gate.
    async with session_factory() as session:
        conv = await ConversationRepository(session).create(user_id=user_id, title="t")
        conv_id = conv.id
        await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=conv_id,
            message_id=new_id(),
            runs=[_run(new_id(), role="captain", total=300)],
        )
        await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=conv_id,
            message_id=new_id(),
            runs=[_run(new_id(), role="captain", total=700)],
        )

    r = await client.get(f"/v1/conversations/{conv_id}/cost")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["conversation_id"] == conv_id
    assert body["cost"]["total"] == 1000
    assert body["turns"] == 2  # two distinct message_ids

    # A non-owner is 404'd (consistent with other conversation reads).
    code2 = await make_invite("INV-CONV-2")
    async with new_client() as other:
        await _register_and_login(other, code2, "convother")
        r = await other.get(f"/v1/conversations/{conv_id}/cost")
    assert r.status_code == 404


async def test_usage_summary_windows_and_quota(client, make_invite, session_factory):
    code = await make_invite("INV-SUMMARY")
    user_id = await _register_and_login(client, code, "summaryuser")

    async with session_factory() as session:
        await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=new_id(),
            message_id=new_id(),
            runs=[_run(new_id(), role="captain", total=2500)],
        )

    r = await client.get("/v1/usage/summary")
    assert r.status_code == 200, r.text
    body = r.json()

    # The seeded row lands in both today's and this month's windows.
    assert body["today"]["cost"]["total"] == 2500
    assert body["month"]["cost"]["total"] == 2500
    assert body["today"]["requests"] == 1
    assert body["today"]["usage"]["input"] == 100
    # Quota defaults (决策④) + the single display FX rate are surfaced.
    assert body["quota"]["daily_tokens"] == 2_000_000
    assert body["quota"]["monthly_cost_nano"] == 5 * 1_000_000_000
    assert body["quota"]["daily_requests"] == 200
    assert body["cny_per_usd"] == 7.2


async def test_usage_summary_empty_is_zero(client, make_invite):
    code = await make_invite("INV-EMPTY")
    await _register_and_login(client, code, "emptyuser")

    r = await client.get("/v1/usage/summary")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["today"]["cost"]["total"] == 0
    assert body["today"]["requests"] == 0
    assert body["month"]["usage"]["input"] == 0
