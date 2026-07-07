"""Tests for reflection interval helper (BE-24)."""

from __future__ import annotations

from agentcore.simulation.agents.reflection import REFLECTION_INTERVAL_TICKS, should_reflect


def test_should_reflect_every_interval():
    assert not should_reflect(0)
    assert not should_reflect(1)
    assert should_reflect(REFLECTION_INTERVAL_TICKS)
    assert should_reflect(REFLECTION_INTERVAL_TICKS * 2)
    assert not should_reflect(REFLECTION_INTERVAL_TICKS + 1)
