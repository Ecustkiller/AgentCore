"""BYOK (bring-your-own-key) credential resolution.

Beta runs DeepSeek-only BYOK (config.billing_mode): every turn runs on the
user's own DeepSeek API key. The endpoint/model are fixed by server config and
never chosen by the user — this module only decrypts the stored key and resolves
it into the per-turn :class:`LLMCredentials` the runtime injects into
``build_provider``.

The single ``resolve_user_llm_credentials`` is shared by the route preflight and
the offline background passes (title/memory) so they decide identically:
"preflight passes" == "the turn runs on this key". Resolution is pure (no state
mutation) and fail-safe — anything off (no row, no master key, undecryptable
ciphertext) returns ``None`` rather than raising, so a misconfigured key can
never leak as plaintext or crash a turn.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.repositories import UserLlmKeyRepository
from agentcore.llm.credentials import (
    INFERENCE_CONVERSATION_HEADER,
    INFERENCE_TRACE_HEADER,
    LLMCredentials,
)
from agentcore.security.keys import KeyEncryptor

logger = get_logger(__name__)

__all__ = [
    "INFERENCE_CONVERSATION_HEADER",
    "INFERENCE_TRACE_HEADER",
    "LLMCredentials",
    "resolve_user_llm_credentials",
]


def _encryptor() -> KeyEncryptor | None:
    """The configured AES encryptor, or ``None`` when no master key is set.

    Fail-safe: a server without ``encryption_key`` cannot store or read BYOK keys,
    so resolution returns ``None`` (and the set-key endpoint refuses to store).
    """
    if not settings.encryption_key:
        return None
    return KeyEncryptor(settings.encryption_key)


async def resolve_user_llm_credentials(
    session: AsyncSession, user_id: str
) -> LLMCredentials | None:
    """Resolve ``user_id``'s BYOK credentials, or ``None`` when unusable.

    ``None`` means "no usable user key": no key row, no master key configured, or
    decryption failed. Callers interpret it per billing mode — the route preflight
    refuses the turn in BYOK mode; ``build_provider(None)`` falls back to the
    platform key in platform mode. Never raises (best-effort, fail-safe).
    """
    row = await UserLlmKeyRepository(session).get_by_user_id(user_id)
    if row is None or not row.api_key_enc:
        return None
    enc = _encryptor()
    if enc is None:
        return None
    try:
        api_key = enc.decrypt(row.api_key_enc).decode()
    except Exception as e:  # malformed/rotated master key — never leak, never crash
        logger.warning("byok.decrypt_failed", user_id=user_id, error=str(e))
        return None
    return LLMCredentials(api_key=api_key, base_url=settings.deepseek_base_url)
