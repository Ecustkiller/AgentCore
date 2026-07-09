"""M1 closed-loop tests: create run → 1 agent → 1 tick → events + tick readback."""

from __future__ import annotations

import json

import pytest

from agentcore.evals.spikes.sim.mock_provider import ScriptedProvider, content_chunk
from agentcore.runtime.events import EventType
from agentcore.simulation.agents.tick_runner import run_agent_tick
from agentcore.simulation.scenarios.town.config import LIN_PERSONA, seed_town_world
from agentcore.simulation.types import SimTickSnapshot
from agentcore.simulation.world.engine import WorldEngine


def _text_json_provider(destination: str = "市场") -> ScriptedProvider:
    payload = json.dumps(
        {
            "action": "move_to",
            "destination": destination,
            "reason": "去进面粉",
            "thought": "得赶紧去市场进原料。",
        },
        ensure_ascii=False,
    )
    return ScriptedProvider([[content_chunk(payload)]])


@pytest.mark.asyncio
async def test_single_agent_tick_text_json_moves_agent():
    world = seed_town_world()
    engine = WorldEngine(world=world)
    await engine.advance()
    outcome = await run_agent_tick(
        world=world,
        persona=LIN_PERSONA,
        llm=_text_json_provider(),
        run_id="test-run",
        text_mode=True,
    )
    assert outcome.error is None
    assert outcome.action.action == "move_to"
    assert world.agents["lin"].location == "市场"
    assert world.agents["lin"].position.x == 24


@pytest.mark.asyncio
async def test_world_engine_snapshot_roundtrip():
    world = seed_town_world()
    engine = WorldEngine(world=world)
    snap = await engine.advance()
    assert snap.tick == 1
    assert snap.hour == 9
    world2 = seed_town_world()
    world2.load_snapshot(snap)
    assert world2.tick == 1
    assert "lin" in world2.agents


def test_sim_event_types_registered():
    assert EventType.SIM_TICK_STARTED.value == "sim.tick_started"
    assert EventType.SIM_TICK_ENDED.value == "sim.tick_ended"
    assert EventType.SIM_AGENT_ACTION.value == "sim.agent_action"
    assert EventType.SIM_AGENT_STATE.value == "sim.agent_state"
    assert EventType.SIM_WORLD_EVENT.value == "sim.world_event"


def test_tick_snapshot_schema():
    snap = SimTickSnapshot(tick=1, hour=9, agents={}, event_log=[])
    assert snap.model_dump()["tick"] == 1
