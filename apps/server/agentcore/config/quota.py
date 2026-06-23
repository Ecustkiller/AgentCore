"""Cost display and free-tier quota settings."""

from pydantic import BaseModel


class QuotaSettings(BaseModel):
    cny_per_usd: float = 7.2
    quota_daily_tokens: int = 2_000_000
    quota_monthly_cost_usd: float = 5.0
    quota_daily_requests: int = 200
