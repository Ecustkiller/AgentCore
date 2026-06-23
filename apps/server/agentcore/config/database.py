"""Database and cache connection settings."""

from pydantic import BaseModel


class DatabaseSettings(BaseModel):
    database_url: str = "postgresql+asyncpg://agentcore:agentcore@localhost:5432/agentcore"
    redis_url: str = "redis://localhost:6379/0"

    # SQLAlchemy statement echo — deliberately DECOUPLED from `debug`. Turning on
    # app-level DEBUG logging should NOT also dump every SQL statement + bound
    # parameters to stdout: that回显 drowns the AI turn logs (产品AI日志) and makes a
    # conversation impossible to follow. Flip this on only when diagnosing a query;
    # it stays off even in dev by default.
    db_echo: bool = False
