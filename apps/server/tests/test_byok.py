"""Unit tests for BYOK helpers: key masking + the DeepSeek connectivity probe.

Pure / mocked — no DB and no network (the probe's HTTP client is stubbed), so
these run in the unit lane. End-to-end resolution, the key routes, and the
billing preflight are covered by tests/integration/test_llm_key_api.py.
"""

import httpx
import pytest

from agentcore.core.errors import (
    LLMError,
    LLMInsufficientBalanceError,
    LLMTimeoutError,
)
from agentcore.llm.config import DEEPSEEK_V4_FLASH
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.key_service import _mask_key

# --- key masking ---


def test_mask_key_shows_last_four():
    assert _mask_key("sk-abcdef1234") == "••••1234"


def test_mask_key_hides_short_key_entirely():
    assert _mask_key("abc") == "••••"
    assert _mask_key("abcd") == "••••"


# --- connectivity probe (DeepSeekProvider.probe) ---


class _Resp:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


def _provider(post_handler) -> DeepSeekProvider:
    """A provider whose HTTP ``post`` is stubbed (no real network)."""
    provider = DeepSeekProvider(api_key="k", base_url="http://example.invalid")
    provider._client.post = post_handler
    return provider


async def test_probe_passes_on_2xx():
    async def post(*a, **k):
        return _Resp(200)

    provider = _provider(post)
    try:
        await provider.probe(model=DEEPSEEK_V4_FLASH)  # no raise == reachable
    finally:
        await provider.close()


async def test_probe_treats_429_as_reachable():
    # 429 means the key authenticated (just throttled), so the key IS valid.
    async def post(*a, **k):
        return _Resp(429)

    provider = _provider(post)
    try:
        await provider.probe(model=DEEPSEEK_V4_FLASH)
    finally:
        await provider.close()


@pytest.mark.parametrize("code", [400, 401, 403, 404, 500, 503])
async def test_probe_raises_on_failure_codes(code):
    async def post(*a, **k):
        return _Resp(code)

    provider = _provider(post)
    try:
        with pytest.raises(LLMError):
            await provider.probe(model=DEEPSEEK_V4_FLASH)
    finally:
        await provider.close()


async def test_probe_maps_402_to_insufficient_balance():
    # 402 = the key authenticated (it IS valid) but the account is out of balance;
    # the probe should tell the user to top up rather than re-check the key.
    async def post(*a, **k):
        return _Resp(402)

    provider = _provider(post)
    try:
        with pytest.raises(LLMInsufficientBalanceError) as ei:
            await provider.probe(model=DEEPSEEK_V4_FLASH)
        assert "余额" in str(ei.value)
    finally:
        await provider.close()


async def test_probe_raises_timeout_on_httpx_timeout():
    async def post(*a, **k):
        raise httpx.TimeoutException("slow")

    provider = _provider(post)
    try:
        with pytest.raises(LLMTimeoutError):
            await provider.probe(model=DEEPSEEK_V4_FLASH)
    finally:
        await provider.close()
