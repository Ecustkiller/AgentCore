"""AI Town simulation runtime tuning (M2+)."""

from pydantic import BaseModel, Field


class SimulationSettings(BaseModel):
    """Concurrency and timeout knobs for batch tick execution."""

    max_parallel_agents: int = Field(default=6, ge=1, le=32)
    agent_tick_timeout_seconds: float = Field(default=120.0, ge=1.0, le=600.0)
