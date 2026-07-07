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

import pytest

from agentcore.api.routes.conversations import _preflight_turn_llm
from agentcore.config import settings
from agentcore.core.errors import LLMError, QuotaExceededError
from agentcore.core.types import new_id
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    UserLlmKeyRepository,
    UserRepository,
)
from agentcore.llm.key_service import LlmKeyService
from agentcore.llm.tools_gate import TOOLS_SOFT_GATE_WARNING
from tests.integration.conftest import register_and_login

_MASTER_KEY = "a" * 64
_OVER_MONTHLY_NANO = 6_000_000_000  # above the default $5 monthly cap


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


async def _set_billing_preference(
    session_factory, *, user_id: str, billing_preference: str
) -> None:
    async with session_factory() as session:
        await UserRepository(session).set_billing_preference(user_id, billing_preference)


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
    await register_and_login(client, code, "keyuser1")

    body = (await client.get("/v1/users/me/llm-key")).json()
    assert body["configured"] is False
    assert body["status"] == "unconfigured"
    assert body["masked_key"] is None


async def test_set_key_stores_and_masks(client, make_invite, byok):
    code = await make_invite("INV-KEY-SET")
    await register_and_login(client, code, "keyuser2")

    r = await client.put(
        "/v1/users/me/llm-key",
        json={
            "api_key": "sk-deepseek-abcd1234",
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-4o",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["status"] == "unchecked"  # a freshly set key is not yet tested
    assert body["masked_key"] == "••••1234"  # last 4 only, never the full key
    assert body["base_url"] == "https://api.openai.com/v1"
    assert body["default_model"] == "gpt-4o"
    assert body["supports_tools"] is None

    # Persisted: GET echoes the same masked view.
    again = (await client.get("/v1/users/me/llm-key")).json()
    assert again["configured"] is True
    assert again["masked_key"] == "••••1234"
    assert again["base_url"] == "https://api.openai.com/v1"
    assert again["default_model"] == "gpt-4o"


async def test_set_key_key_only_uses_defaults(client, make_invite, byok):
    code = await make_invite("INV-KEY-DEF")
    await register_and_login(client, code, "keyuser2b")

    r = await client.put("/v1/users/me/llm-key", json={"api_key": "sk-legacy-key-9999"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["base_url"] == settings.platform_base_url
    assert body["default_model"] == "deepseek-v4-flash"


async def test_set_key_refused_without_master_key(client, make_invite, monkeypatch):
    monkeypatch.setattr(settings, "billing_mode", "byok")
    monkeypatch.setattr(settings, "encryption_key", "")  # no master key → can't store
    code = await make_invite("INV-KEY-NOMASTER")
    await register_and_login(client, code, "keyuser3")

    r = await client.put("/v1/users/me/llm-key", json={"api_key": "sk-x"})
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "KEY_STORAGE_UNAVAILABLE"


async def test_delete_key_clears_it(client, make_invite, byok):
    code = await make_invite("INV-KEY-DEL")
    await register_and_login(client, code, "keyuser4")
    await client.put("/v1/users/me/llm-key", json={"api_key": "sk-to-delete-9999"})

    r = await client.delete("/v1/users/me/llm-key")
    assert r.status_code == 200, r.text

    body = (await client.get("/v1/users/me/llm-key")).json()
    assert body["configured"] is False
    assert body["status"] == "unconfigured"


# --- connectivity test (POST .../test), with the provider stubbed ---


class _FakeProvider:
    def __init__(self, *, fail: bool, supports_tools: bool = True) -> None:
        self._fail = fail
        self._supports_tools = supports_tools
        self.probe_model: str | None = None

    async def probe(self, *, model: str) -> None:
        self.probe_model = model
        if self._fail:
            raise LLMError("API Key 无效或无权限（鉴权失败），请检查后重试")

    async def probe_tools(self, *, model: str) -> bool:
        return self._supports_tools

    async def close(self) -> None:
        pass


async def test_test_key_active_on_probe_success(client, make_invite, byok, monkeypatch):
    code = await make_invite("INV-KEY-TESTOK")
    await register_and_login(client, code, "keyuser5")
    await client.put(
        "/v1/users/me/llm-key",
        json={
            "api_key": "sk-good-key-4242",
            "default_model": "gpt-4o-mini",
        },
    )
    fake = _FakeProvider(fail=False, supports_tools=True)
    monkeypatch.setattr(
        "agentcore.llm.key_service.build_provider", lambda creds: fake
    )

    r = await client.post("/v1/users/me/llm-key/test")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "active"
    assert body["supports_tools"] is True
    assert fake.probe_model == "gpt-4o-mini"

    # Outcome persisted for the settings dot.
    assert (await client.get("/v1/users/me/llm-key")).json()["status"] == "active"
    assert (await client.get("/v1/users/me/llm-key")).json()["supports_tools"] is True


async def test_test_key_records_no_tools_hint(client, make_invite, byok, monkeypatch):
    code = await make_invite("INV-KEY-NOTOOLS")
    await register_and_login(client, code, "keyuser5b")
    await client.put("/v1/users/me/llm-key", json={"api_key": "sk-chat-only-1111"})
    monkeypatch.setattr(
        "agentcore.llm.key_service.build_provider",
        lambda creds: _FakeProvider(fail=False, supports_tools=False),
    )

    r = await client.post("/v1/users/me/llm-key/test")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "active"
    assert body["supports_tools"] is False


async def test_test_key_error_on_probe_failure(client, make_invite, byok, monkeypatch):
    code = await make_invite("INV-KEY-TESTERR")
    await register_and_login(client, code, "keyuser6")
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
    await register_and_login(client, code, "keyuser7")

    r = await client.post("/v1/users/me/llm-key/test")
    assert r.status_code == 402, r.text
    assert r.json()["error"]["code"] == "LLM_KEY_REQUIRED"


# --- billing preflight (route + gate) ---


async def test_send_message_refused_without_byok_key(client, make_invite, session_factory, byok):
    code = await make_invite("INV-KEY-PREFLIGHT")
    user_id = await register_and_login(client, code, "keyuser8")
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
    user_id = await register_and_login(client, code, "keyuser9")
    conv_id = await _make_conversation(session_factory, user_id=user_id)
    await _seed_spend(
        session_factory, user_id=user_id, conversation_id=conv_id, total=_OVER_MONTHLY_NANO
    )
    await _store_key(session_factory, user_id=user_id, api_key="sk-byok-user-1234")

    async with session_factory() as session:
        user = await UserRepository(session).get_by_id(user_id)
        result = await _preflight_turn_llm(
            session=session, user=user, cost_repo=CostEventRepository(session)
        )
    assert result.credentials is not None
    assert result.credentials.api_key == "sk-byok-user-1234"
    assert result.credentials.base_url == settings.platform_base_url
    assert result.credentials.default_model == "deepseek-v4-flash"


async def test_preflight_tools_soft_gate_warning(
    client, make_invite, session_factory, byok
):
    code = await make_invite("INV-TOOLS-GATE")
    user_id = await register_and_login(client, code, "keyuser_tools")
    await _store_key(session_factory, user_id=user_id, api_key="sk-byok-tools")

    async with session_factory() as session:
        await UserLlmKeyRepository(session).update_supports_tools(user_id, False)
        user = await UserRepository(session).get_by_id(user_id)
        result = await _preflight_turn_llm(
            session=session,
            user=user,
            cost_repo=CostEventRepository(session),
            needs_tools=True,
        )
        assert result.warnings == [TOOLS_SOFT_GATE_WARNING]
        plain = await _preflight_turn_llm(
            session=session,
            user=user,
            cost_repo=CostEventRepository(session),
            needs_tools=False,
        )
        assert plain.warnings == []


async def test_preflight_platform_enforces_quota(client, make_invite, session_factory, monkeypatch):
    # Same over-quota ledger, but platform billing → the quota gate fires.
    monkeypatch.setattr(settings, "billing_mode", "platform")
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    code = await make_invite("INV-KEY-PLATQ")
    user_id = await register_and_login(client, code, "keyuser10")
    await _set_billing_preference(
        session_factory, user_id=user_id, billing_preference="platform"
    )
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


async def test_get_status_includes_billing_capability(client, make_invite, byok, monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    code = await make_invite("INV-BILL-CAP")
    await register_and_login(client, code, "billcap")

    body = (await client.get("/v1/users/me/llm-key")).json()
    assert body["billing_mode"] == "byok"
    assert body["billing_preference"] == "byok"
    assert body["platform_available"] is True


async def test_set_billing_preference_platform(client, make_invite, byok, monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    monkeypatch.setattr(settings, "platform_model", "gpt-5")
    code = await make_invite("INV-BILL-PLAT")
    await register_and_login(client, code, "billplat")

    r = await client.put(
        "/v1/users/me/llm-key/billing-preference",
        json={"billing_preference": "platform"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["billing_mode"] == "platform"
    assert body["billing_preference"] == "platform"
    assert body["status"] == "platform"
    assert body["default_model"] == "gpt-5"


async def test_set_billing_preference_platform_unavailable(client, make_invite, byok, monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    code = await make_invite("INV-BILL-NOPLAT")
    await register_and_login(client, code, "billnoplat")

    r = await client.put(
        "/v1/users/me/llm-key/billing-preference",
        json={"billing_preference": "platform"},
    )
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "PLATFORM_BILLING_UNAVAILABLE"
