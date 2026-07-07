"""Per-agent tick memory — sliding window of one-line summaries (BE-12)."""

from __future__ import annotations

from collections.abc import Sequence

from agentcore.simulation.agents.models import SimPersona
from agentcore.simulation.scenarios.town.config import schedule_hint_for_persona
from agentcore.simulation.types import SimAgentAction
from agentcore.simulation.world.state import WorldAgent, WorldState

MAX_TICK_MEMORIES = 10


def append_tick_memory(agent: WorldAgent, summary: str) -> None:
    """Append a summary and trim to the sliding window."""
    agent.tick_memories.append(summary)
    if len(agent.tick_memories) > MAX_TICK_MEMORIES:
        agent.tick_memories = agent.tick_memories[-MAX_TICK_MEMORIES:]


def format_tick_memories_for_perception(memories: Sequence[str]) -> str:
    """Render stored summaries for injection into agent perception."""
    if not memories:
        return ""
    lines = "\n".join(f"- {m}" for m in memories)
    return f"【你的近期记忆】\n{lines}"


def _describe_action(agent: WorldAgent, action: SimAgentAction) -> str:
    args = action.tool_args or {}
    if action.action == "move_to":
        dest = str(args.get("destination", "")).strip() or agent.location
        return f"前往了{dest}"
    if action.action == "stay_here":
        activity = str(args.get("activity", "")).strip() or agent.activity
        return f"留在{agent.location}做{activity}"
    if action.action == "speak_to":
        target = str(args.get("target_name", "")).strip() or "某人"
        return f"与{target}交谈"
    if action.action == "error" or not action.success:
        return "尝试行动但失败了"
    return f"在{agent.location}{agent.activity}"


def _describe_encounter(world: WorldState, agent: WorldAgent) -> str:
    prefix = f"tick{world.tick}"
    relevant = [
        line
        for line in world.event_log
        if line.startswith(prefix) and agent.name in line
    ]
    if relevant:
        tail = relevant[-1].split(agent.name, 1)[-1].strip()
        return tail.lstrip("，").strip() or "镇上的公共事件"
    here = world.agents_at(agent.location, exclude=agent.agent_id)
    if here:
        names = "、".join(a.name for a in here)
        return f"同处此地的{names}"
    return "无特别事件"


def summarize_agent_tick(
    *,
    tick: int,
    agent: WorldAgent,
    action: SimAgentAction,
    encounter: str,
) -> str:
    """Fixed-format one-line summary: 在 tick N，你做了 X，遇到了 Y."""
    action_desc = _describe_action(agent, action)
    return f"在 tick {tick}，你{action_desc}，遇到了{encounter}"


def summarize_schedule_fallback(
    *,
    tick: int,
    location: str,
    activity: str,
) -> str:
    return f"在 tick {tick}，你按日程在{location}{activity}，遇到了无特别事件"


def apply_tick_memories(
    world: WorldState,
    outcomes: Sequence[object],
    skipped: Sequence[SimPersona],
) -> None:
    """Write one summary per agent at end of tick (after outcomes are known)."""
    tick = world.tick
    for outcome in outcomes:
        action = getattr(outcome, "action", None)
        if action is None:
            continue
        agent_id = action.agent_id
        agent = world.agents.get(agent_id)
        if agent is None:
            continue
        encounter = _describe_encounter(world, agent)
        summary = summarize_agent_tick(
            tick=tick, agent=agent, action=action, encounter=encounter
        )
        append_tick_memory(agent, summary)

    for persona in skipped:
        agent = world.agents.get(persona.agent_id)
        if agent is None:
            continue
        slot = schedule_hint_for_persona(persona, world.hour)
        summary = summarize_schedule_fallback(
            tick=tick, location=slot.location, activity=slot.activity
        )
        append_tick_memory(agent, summary)
