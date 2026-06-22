"""Integration tests for BYOK key management + the billing preflight.

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the /users/me/llm-key routes (status / store / clear / connectivity-test),
the at-rest encryption + last-4 masking, and the turn preflight that refuses a
keyless BYOK turn (402) while letting a keyed BYOK turn skip the platform quota
gate (config.billing_mode, 成本配额与计费.md §一).

The connectivity probe and the chat stream are stubbed so no real DeepSeek call
is made: the /test route's provider is monkeypatched, and "skips quota" is
asserted against the preflight gate directly rather than by opening a stream.
"""

import httpx
import pytest

from agentcore.api.routes.conversations import _preflight_turn_llm
from agentcore.config import settings
from agentcore.core.errors import LLMError, QuotaExceededError
from agentcore.core.types import new_id
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    UserRepository,
)
from agentcore.llm.key_service import LlmKeyService

_PW = "password123"
_MASTER_KEY = "a" * 64
_OVER_MONTHLY_NANO = 6_000_000_000  # above the default $5 monthly cap


async def _register_and_login(client: httpx.AsyncClient, invite_code: str, username: str) -> str:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/v1/auth/login", json={"username": username, "password": _PW})
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def _make_conversation(session_factory, *, user_id: str) -> str:
    async with session_factory() as session:
        conv = await ConversationRepository(session).create(user_id=user_id, title="t")
        return conv.id


def _run(run_id: str, *, total: int) -> dict:
    return {
        "run_id": run_id,
        "parent_run_id": None,
        "agent_id": run_id,
        "role": "captain",
        "model": "deepseek-v4-pro",
        "tokens": {"input": 100, "output": 50, "reasoning": 0, "cache_hit": 0, "cache_miss": 100},
        "cost": {"input": 0, "cached": 0, "output": total, "total": total},
        "cost_total_nano": total,
        "currency": "USD",
        "rounds": 1,
        "duration_ms": 1,
    }


async def _seed_spend(session_factory, *, user_id: str, conversation_id: str, total: int) -> None:
    async with session_factory() as session:
        await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=conversation_id,
            message_id=new_id(),
            runs=[_run(new_id(), total=total)],
        )


async def _store_key(session_factory, *, user_id: str, api_key: str) -> None:
    async with session_factory() as session:
        await LlmKeyService(session).set_key(user_id, api_key)


@pytest.fixture
def byok(monkeypatch):
    """BYOK billing + a valid master key configured (auto-restored)."""
    monkeypatch.setattr(settings, "billing_mode", "byok")
    monkeypatch.setattr(settings, "encryption_key", _MASTER_KEY)


# --- auth gate ---


async def test_llm_key_routes_require_auth(client):
    assert (await client.get("/v1/users/me/llm-key")).status_code == 401
    assert (await client.put("/v1/users/me/llm-key", json={"api_key": "x"})).status_code == 401
    assert (await client.delete("/v1/users/me/llm-key")).status_code == 401
    assert (await client.post("/v1/users/me/llm-key/test")).status_code == 401


# --- status / store / mask / clear lifecycle ---


async def test_get_status_unconfigured(client, make_invite, byok):
    code = await make_invite("INV-KEY-UNCONF")
    await _register_and_login(client, code, "keyuser1")

    body = (await client.get("/v1/users/me/llm-key")).json()
    assert body["configured"] is False
    assert body["status"] == "unconfigured"
    assert body["masked_key"] is None


async def test_set_key_stores_and_masks(client, make_invite, byok):
    code = await make_invite("INV-KEY-SET")
    await _register_and_login(client, code, "keyuser2")

    r = await client.put("/v1/users/me/llm-key", json={"api_key": "sk-deepseek-abcd1234"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["status"] == "unchecked"  # a freshly set key is not yet tested
    assert body["masked_key"] == "••••1234"  # last 4 only, never the full key

    # Persisted: GET echoes the same masked view.
    again = (await client.get("/v1/users/me/llm-key")).json()
    assert again["configured"] is True
    assert again["masked_key"] == "••••1234"


async def test_set_key_refused_without_master_key(client, make_invite, monkeypatch):
    monkeypatch.setattr(settings, "billing_mode", "byok")
    monkeypatch.setattr(settings, "encryption_key", "")  # no master key → can't store
    code = await make_invite("INV-KEY-NOMASTER")
    await _register_and_login(client, code, "keyuser3")

    r = await client.put("/v1/users/me/llm-key", json={"api_key": "sk-x"})
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "KEY_STORAGE_UNAVAILABLE"


async def test_delete_key_clears_it(client, make_invite, byok):
    code = await make_invite("INV-KEY-DEL")
    await _register_and_login(client, code, "keyuser4")
    await client.put("/v1/users/me/llm-key", json={"api_key": "sk-to-delete-9999"})

    r = await client.delete("/v1/users/me/llm-key")
    assert r.status_code == 200, r.text

    body = (await client.get("/v1/users/me/llm-key")).json()
    assert body["configured"] is False
    assert body["status"] == "unconfigured"


# --- connectivity test (POST .../test), with the provider stubbed ---


class _FakeProvider:
    def __init__(self, *, fail: bool) -> None:
        self._fail = fail

    async def probe(self, *, model: str) -> None:
        if self._fail:
            raise LLMError("API Key 无效或无权限（鉴权失败），请检查后重试")

    async def close(self) -> None:
        pass


async def test_test_key_active_on_probe_success(client, make_invite, byok, monkeypatch):
    code = await make_invite("INV-KEY-TESTOK")
    await _register_and_login(client, code, "keyuser5")
    await client.put("/v1/users/me/llm-key", json={"api_key": "sk-good-key-4242"})
    monkeypatch.setattr(
        "agentcore.llm.key_service.build_provider", lambda creds: _FakeProvider(fail=False)
    )

    r = await client.post("/v1/users/me/llm-key/test")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"

    # Outcome persisted for the settings dot.
    assert (await client.get("/v1/users/me/llm-key")).json()["status"] == "active"


async def test_test_key_error_on_probe_failure(client, make_invite, byok, monkeypatch):
    code = await make_invite("INV-KEY-TESTERR")
    await _register_and_login(client, code, "keyuser6")
    await client.put("/v1/users/me/llm-key", json={"api_key": "sk-bad-key-0000"})
    monkeypatch.setattr(
        "agentcore.llm.key_service.build_provider", lambda creds: _FakeProvider(fail=True)
    )

    r = await client.post("/v1/users/me/llm-key/test")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "error"
    assert body["message"]  # surfaces why it failed

    assert (await client.get("/v1/users/me/llm-key")).json()["status"] == "error"


async def test_test_key_without_key_returns_402(client, make_invite, byok):
    code = await make_invite("INV-KEY-TESTNONE")
    await _register_and_login(client, code, "keyuser7")

    r = await client.post("/v1/users/me/llm-key/test")
    assert r.status_code == 402, r.text
    assert r.json()["error"]["code"] == "LLM_KEY_REQUIRED"


# --- billing preflight (route + gate) ---


async def test_send_message_refused_without_byok_key(client, make_invite, session_factory, byok):
    code = await make_invite("INV-KEY-PREFLIGHT")
    user_id = await _register_and_login(client, code, "keyuser8")
    conv_id = await _make_conversation(session_factory, user_id=user_id)

    r = await client.post(f"/v1/conversations/{conv_id}/messages", json={"content": "hi"})
    assert r.status_code == 402, r.text
    assert r.json()["error"]["code"] == "LLM_KEY_REQUIRED"


async def test_preflight_byok_skips_quota_when_key_present(
    client, make_invite, session_factory, byok
):
    # BYOK turn runs on the user's own key, so the platform quota gate is dormant:
    # even over the platform cap, the keyed preflight returns credentials (no 429).
    code = await make_invite("INV-KEY-SKIPQ")
    user_id = await _register_and_login(client, code, "keyuser9")
    conv_id = await _make_conversation(session_factory, user_id=user_id)
    await _seed_spend(
        session_factory, user_id=user_id, conversation_id=conv_id, total=_OVER_MONTHLY_NANO
    )
    await _store_key(session_factory, user_id=user_id, api_key="sk-byok-user-1234")

    async with session_factory() as session:
        user = await UserRepository(session).get_by_id(user_id)
        creds = await _preflight_turn_llm(
            session=session, user=user, cost_repo=CostEventRepository(session)
        )
    assert creds is not None
    assert creds.api_key == "sk-byok-user-1234"


async def test_preflight_platform_enforces_quota(client, make_invite, session_factory, monkeypatch):
    # Same over-quota ledger, but platform billing → the quota gate fires.
    monkeypatch.setattr(settings, "billing_mode", "platform")
    code = await make_invite("INV-KEY-PLATQ")
    user_id = await _register_and_login(client, code, "keyuser10")
    conv_id = await _make_conversation(session_factory, user_id=user_id)
    await _seed_spend(
        session_factory, user_id=user_id, conversation_id=conv_id, total=_OVER_MONTHLY_NANO
    )

    async with session_factory() as session:
        user = await UserRepository(session).get_by_id(user_id)
        with pytest.raises(QuotaExceededError):
            await _preflight_turn_llm(
                session=session, user=user, cost_repo=CostEventRepository(session)
            )
