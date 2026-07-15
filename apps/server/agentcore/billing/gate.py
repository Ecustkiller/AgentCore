"""Shared LLM billing preflight for user-facing call sites.

Chat turns, file assist, and the inference proxy all refuse or admit an LLM call
with the same per-user billing decision (``resolve_effective_billing_mode``):
BYOK requires the user's own key (or free-tier platform fallback); platform
enforces quota then runs on the global key.
"""

from __future__ import annotations

from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.billing.preference import is_free_tier_enabled, resolve_effective_billing_mode
from agentcore.config import settings
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.core.errors import BYOKKeyMissingError, PlatformBillingUnavailableError
from agentcore.db.repositories import CostEventRepository
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.resolve import platform_llm_credentials, resolve_user_llm_credentials

_PLATFORM_UNAVAILABLE_MESSAGE = (
    "平台免费额度暂不可用（运营方未配置平台 Key）。请在设置中切换为自带 API Key，或联系管理员。"
)


class _BillingGateUser(Protocol):
    user_id: str
    billing_preference: str


async def preflight_llm_credentials(
    *,
    session: AsyncSession,
    user: _BillingGateUser,
    cost_repo: CostEventRepository,
    byok_missing_message: str,
) -> LLMCredentials | None:
    """Run the shared billing gate before a user-facing LLM call.

    Returns resolved BYOK credentials, or ``None`` when the turn runs on the
    platform key (quota already enforced). Raises ``BYOKKeyMissingError`` (402),
    ``FreeTierExhaustedError`` / ``QuotaExceededError`` (429), or
    ``PlatformBillingUnavailableError`` (503) when the call must be refused.
    """
    billing_mode = resolve_effective_billing_mode(user)
    free_tier_path = False
    if billing_mode == "byok":
        credentials = await resolve_user_llm_credentials(session, user.user_id)
        if credentials is not None:
            return credentials
        # Free-tier fallback: keyless BYOK → platform-paid when switch + key ready.
        if not (is_free_tier_enabled() and platform_llm_credentials() is not None):
            raise BYOKKeyMissingError(byok_missing_message)
        free_tier_path = True

    if platform_llm_credentials() is None:
        raise PlatformBillingUnavailableError(_PLATFORM_UNAVAILABLE_MESSAGE)
    # D7: byok deployments use free_tier_* defaults on every platform-paid path;
    # full platform deployments keep global quota_* defaults.
    use_free_tier_defaults = settings.billing_mode == "byok"
    await enforce_quota(
        cost_repo,
        user.user_id,
        limits=QuotaLimits.for_user(user, use_free_tier_defaults=use_free_tier_defaults),
        free_tier=free_tier_path,
    )
    return None
