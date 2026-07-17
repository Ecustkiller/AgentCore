"""辩论检索 token 预算独立于 worker 通用顶。"""

from __future__ import annotations

from agentcore.config.engine import EngineSettings


def test_debate_token_ceiling_independent_default():
    """新配置项默认 ≥120k，且与 worker 80k 顶分离。"""
    s = EngineSettings()
    assert s.engine_worker_token_ceiling == 80_000
    assert s.engine_debate_token_ceiling == 120_000
    assert s.engine_debate_token_ceiling >= 120_000
    assert s.engine_debate_token_ceiling != s.engine_worker_token_ceiling


def test_debate_token_ceiling_can_override_independently():
    s = EngineSettings(
        engine_worker_token_ceiling=50_000,
        engine_debate_token_ceiling=200_000,
    )
    assert s.engine_worker_token_ceiling == 50_000
    assert s.engine_debate_token_ceiling == 200_000
