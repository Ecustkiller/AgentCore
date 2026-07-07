"""Resolve per-user billing mode (platform free quota vs BYOK)."""

from __future__ import annotations

from typing import Literal, Protocol

from agentcore.config import settings

BillingMode = Literal["platform", "byok"]

_VALID_MODES = frozenset({"platform", "byok"})


class _BillingUser(Protocol):
    billing_preference: str


def default_billing_preference() -> BillingMode:
    """Deployment default for new accounts and migration backfill."""
    mode = settings.billing_mode
    if mode in _VALID_MODES:
        return mode  # type: ignore[return-value]
    return "byok"


def is_platform_available() -> bool:
    """Whether the operator configured a platform upstream key."""
    return bool(settings.platform_api_key.strip())


def resolve_effective_billing_mode(user: _BillingUser | None) -> BillingMode:
    """User preference when set; otherwise the deployment default."""
    if user is None:
        return default_billing_preference()
    pref = getattr(user, "billing_preference", None)
    if pref in _VALID_MODES:
        return pref  # type: ignore[return-value]
    return default_billing_preference()


def validate_billing_preference(value: str) -> BillingMode:
    """Normalize and validate a preference write."""
    if value not in _VALID_MODES:
        raise ValueError(f"billing_preference must be one of {sorted(_VALID_MODES)}")
    return value  # type: ignore[return-value]
