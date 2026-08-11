"""Database and cache connection settings."""

from pydantic import BaseModel, Field


class DatabaseSettings(BaseModel):
    database_url: str = "postgresql+asyncpg://agentcore:agentcore@localhost:5432/agentcore"
    redis_url: str = "redis://localhost:6379/0"

    # SQLAlchemy statement echo — deliberately DECOUPLED from `debug`. Turning on
    # app-level DEBUG logging should NOT also dump every SQL statement + bound
    # parameters to stdout: that回显 drowns the AI turn logs (产品AI日志) and makes a
    # conversation impossible to follow. Flip this on only when diagnosing a query;
    # it stays off even in dev by default.
    db_echo: bool = False

    # Connection-pool budget (as-built: 成本配额 §三).
    # Split so mid-turn telemetry (proxy_spend / journal / audit / roster) never
    # starves content writes (messages finalize / checkpoint / request sessions).
    # Defaults keep the historical ~40-connection ceiling: 16+16 primary + 4+4 telemetry.
    db_pool_size: int = Field(default=16, ge=1)
    db_max_overflow: int = Field(default=16, ge=0)
    # Fast-fail under pool pressure: waiting the historical 30s only delayed a
    # 503/500 for the user while holding the request open. Keep capacity (16+16)
    # unchanged; shorten the checkout wait and map TimeoutError → 503 product copy.
    db_pool_timeout: int = Field(default=5, ge=1)

    db_telemetry_pool_size: int = Field(default=4, ge=1)
    db_telemetry_max_overflow: int = Field(default=4, ge=0)
    db_telemetry_pool_timeout: int = Field(default=30, ge=1)

    # Pool holder observability (observation only — does not change capacity).
    # Slow checkin warning: a connection returned after this many seconds.
    db_pool_hold_warn_s: float = Field(default=10.0, ge=0.1)
    # When checked_out / capacity crosses this ratio, checkout also stores a
    # truncated stack (low occupancy stays contextvars-only — near-zero cost).
    db_pool_trace_occupancy: float = Field(default=0.75, ge=0.0, le=1.0)
    db_pool_stack_frames: int = Field(default=8, ge=0, le=32)
    # Deduplicate exhaustion snapshots when many waiters time out together.
    db_pool_exhaustion_snapshot_cooldown_s: float = Field(default=5.0, ge=0.0)
