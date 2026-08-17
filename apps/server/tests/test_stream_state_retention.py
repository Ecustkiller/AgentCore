"""Unit tests for turn_stream_state TTL sweep (no Postgres)."""

from agentcore.config import settings
from agentcore.runtime import stream_state_retention as retention_mod


async def test_sweep_disabled_when_days_non_positive(monkeypatch):
    monkeypatch.setattr(settings, "turn_stream_state_retention_days", 0)
    assert await retention_mod.run_stream_state_retention_sweep() == 0
    monkeypatch.setattr(settings, "turn_stream_state_retention_days", -1)
    assert await retention_mod.run_stream_state_retention_sweep() == 0
