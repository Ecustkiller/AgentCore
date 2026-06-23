"""CEO checkpoint / ask_user gate and durable suspension settings."""

from pydantic import BaseModel


class CheckpointSettings(BaseModel):
    checkpoint_gate_enabled: bool = True
    checkpoint_timeout_seconds: float = 600.0

    structured_suspension_persist_enabled: bool = True
    paused_turn_retention_days: int = 7
    paused_turn_sweep_interval_seconds: int = 6 * 3600
    paused_turn_sweep_batch_limit: int = 200
