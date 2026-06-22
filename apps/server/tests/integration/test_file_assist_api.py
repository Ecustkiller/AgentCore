"""Integration tests: the AI file-rewrite endpoint's billing gate.

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers ``POST /v1/files/assist/rewrite`` end to end — the one-shot file assist
shares the *same* preflight decision as a chat turn (成本配额与计费.md §一): BYOK
mode refuses a keyless call with 402 ``LLM_KEY_REQUIRED``; platform mode enforces
the usage quota with 429 ``QUOTA_EXCEEDED``. The happy path returns the rewritten
selection. The LLM provider is stubbed so no real DeepSeek call is made, and the
over-quota spend is seeded straight into the ledger.
"""

import httpx
import pytest

from agentcore.config import settings
from agentcore.core.types import new_id
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
)
from agentcore.llm import LLMResponse
from agentcore.llm.key_service import LlmKeyService

_PW = "password123"
_MASTER_KEY = "a" * 64
_OVER_MONTHLY_NANO = 6_000_000_000  # above the default $5 monthly cap
_REWRITE_PATH = "/v1/files/assist/rewrite"
_VALID_BODY = {"selection": "今天天气不错", "instruction": "改得更正式"}
_REWRITTEN = "改写后的文本"


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
    """A per-run ledger payload (runtime ``asdict(RunCost)`` shape) with small token
    counts so the monthly *cost* cap is what trips, not the daily-token cap."""
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


class _FakeProvider:
    """Returns canned content so ``rewrite_selection`` never makes a real LLM call."""

    def __init__(self, content: str) -> None:
        self._content = content

    async def complete(self, request) -> LLMResponse:
        return LLMResponse(content=self._content)


@pytest.fixture
def stub_provider(monkeypatch):
    """Route's ``build_provider`` → a fake provider echoing a fixed rewrite, so the
    happy path stays fully offline (and still exercises the real rewrite_selection)."""
    monkeypatch.setattr(
        "agentcore.api.routes.files.build_provider",
        lambda creds: _FakeProvider(_REWRITTEN),
    )


@pytest.fixture
def byok(monkeypatch):
    """BYOK billing + a valid master key configured (so a stored key round-trips)."""
    monkeypatch.setattr(settings, "billing_mode", "byok")
    monkeypatch.setattr(settings, "encryption_key", _MASTER_KEY)


@pytest.fixture
def platform(monkeypatch):
    """Platform billing → the usage quota is the active 防线 (BYOK 402 is dormant)."""
    monkeypatch.setattr(settings, "billing_mode", "platform")


# --- auth gate ---


async def test_rewrite_requires_auth(client):
    # A valid body (so no 422 pre-empts it) posted without a session is refused.
    r = await client.post(_REWRITE_PATH, json=_VALID_BODY)
    assert r.status_code == 401, r.text


# --- BYOK preflight: 402 when keyless, 200 when keyed ---


async def test_rewrite_refused_without_byok_key(client, make_invite, byok):
    code = await make_invite("INV-RW-NOKEY")
    await _register_and_login(client, code, "rwuser1")

    r = await client.post(_REWRITE_PATH, json=_VALID_BODY)
    assert r.status_code == 402, r.text
    assert r.json()["error"]["code"] == "LLM_KEY_REQUIRED"


async def test_rewrite_with_byok_key_returns_rewritten(
    client, make_invite, session_factory, byok, stub_provider
):
    code = await make_invite("INV-RW-KEY")
    user_id = await _register_and_login(client, code, "rwuser2")
    await _store_key(session_factory, user_id=user_id, api_key="sk-byok-rw-1234")

    r = await client.post(_REWRITE_PATH, json=_VALID_BODY)
    assert r.status_code == 200, r.text
    assert r.json()["rewritten"] == _REWRITTEN


# --- platform preflight: 429 over quota, 200 under ---


async def test_rewrite_blocked_when_over_quota_platform(
    client, make_invite, session_factory, platform
):
    code = await make_invite("INV-RW-QUOTA")
    user_id = await _register_and_login(client, code, "rwuser3")
    conv_id = await _make_conversation(session_factory, user_id=user_id)
    await _seed_spend(
        session_factory, user_id=user_id, conversation_id=conv_id, total=_OVER_MONTHLY_NANO
    )

    r = await client.post(_REWRITE_PATH, json=_VALID_BODY)
    assert r.status_code == 429, r.text
    assert r.json()["error"]["code"] == "QUOTA_EXCEEDED"


async def test_rewrite_under_quota_platform_returns_rewritten(
    client, make_invite, platform, stub_provider
):
    code = await make_invite("INV-RW-OK")
    await _register_and_login(client, code, "rwuser4")

    r = await client.post(_REWRITE_PATH, json=_VALID_BODY)
    assert r.status_code == 200, r.text
    assert r.json()["rewritten"] == _REWRITTEN


# --- schema validation (the route never runs on a malformed body) ---


async def test_rewrite_rejects_empty_selection(client, make_invite, platform):
    code = await make_invite("INV-RW-EMPTY")
    await _register_and_login(client, code, "rwuser5")

    r = await client.post(_REWRITE_PATH, json={"selection": "", "instruction": "改"})
    assert r.status_code == 422, r.text
