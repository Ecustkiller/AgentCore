"""Cost display and free-tier quota settings."""

from pydantic import BaseModel


class QuotaSettings(BaseModel):
    cny_per_usd: float = 7.2
    # Global defaults for billing_mode=platform (full platform-paid deployment).
    quota_daily_tokens: int = 2_000_000
    quota_monthly_cost_usd: float = 5.0
    quota_daily_requests: int = 200
    # Free-tier defaults for byok deployments on any platform-paid path
    # (explicit platform preference or free-tier fallback). ≈¥1 / month.
    free_tier_monthly_cost_usd: float = 0.14
    free_tier_daily_tokens: int = 200_000
    free_tier_daily_requests: int = 50
