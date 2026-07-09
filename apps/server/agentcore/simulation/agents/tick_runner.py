"""Single SimAgent tick via react_loop (bypasses conversation / turn journal)."""

from __future__ import annotations

import json
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from agentcore.config import settings
from agentcore.core.log_context import log_context, new_trace_id
from agentcore.core.types import new_id
from agentcore.evals.recording_sink import RecordingSink
from agentcore.llm.pricing import NANO_PER_USD, calculate_cost
from agentcore.llm.profiles import ProfileParams
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.engine import react_loop
from agentcore.simulation.agents.memory import format_tick_memories_for_perception
from agentcore.simulation.agents.models import (
    MotivationAssessment,
    MotivationSignals,
    SimPersona,
)
from agentcore.simulation.agents.tools import (
    MoveToTool,
    ProposeTradeTool,
    ProposeVoteTool,
    SpeakToTool,
    StayHereTool,
    build_sim_tool_registry,
)
from agentcore.simulation.scenarios.town.schedule import schedule_hint_for_persona
from agentcore.simulation.types import SimAgentAction
from agentcore.simulation.world.state import WorldState
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

_SIM_PROFILE = ProfileParams(temperature=0.8, max_rounds=4, name="sim.town")


@dataclass
class AgentTickOutcome:
    action: SimAgentAction
    rounds: int
    latency_ms: int
    usage: dict[str, int]
    cost_usd: float
    error: str | None = None


def _build_messages(persona: SimPersona, perception: str, *, text_mode: bool) -> list[LLMMessage]:
    if text_mode:
        user_content = (
            f"{persona.system_prompt}\n\n"
            f"{perception}\n\n"
            "请根据你的人设与目标决定本 tick 行动。只输出一个 JSON 对象（不要 markdown），字段：\n"
            '{"action":"move_to|stay_here|speak_to",'
            '"destination":"地点(仅move_to)",'
            '"activity":"活动(仅stay_here)",'
            '"target_name":"姓名(仅speak_to)",'
            '"message":"对话(仅speak_to)",'
            '"reason":"动机",'
            '"thought":"一两句内心想法"}\n'
            "不要复读上一 tick 的原话；行动要具体、符合人设。"
        )
        return [LLMMessage(role="user", content=user_content)]
    user_tail = (
        f"{perception}\n\n"
        "请根据你的人设与目标决定本 tick 行动：先调用一个工具（move_to / stay_here / speak_to），"
        "再简短说明你的想法（不要重复工具参数原文）。"
    )
    return [
        LLMMessage(role="system", content=persona.system_prompt),
        LLMMessage(role="user", content=user_tail),
    ]


def _parse_action_json(text: str) -> dict | None:
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                return None
    return None


async def _apply_parsed_action(
    world: WorldState, payload: dict, ctx: ToolContext
) -> tuple[str, str, str]:
    action = str(payload.get("action", "")).strip()
    args_json = json.dumps(payload, ensure_ascii=False)
    if action == "move_to":
        tool = MoveToTool(world)
        result = await tool.execute(
            {"destination": payload.get("destination", ""), "reason": payload.get("reason", "")},
            ctx,
        )
    elif action == "stay_here":
        tool = StayHereTool(world)
        result = await tool.execute(
            {"activity": payload.get("activity", ""), "reason": payload.get("reason", "")},
            ctx,
        )
    elif action == "speak_to":
        tool = SpeakToTool(world)
        result = await tool.execute(
            {"target_name": payload.get("target_name", ""), "message": payload.get("message", "")},
            ctx,
        )
    elif action == "propose_trade":
        tool = ProposeTradeTool(world)
        result = await tool.execute(
            {
                "target_name": payload.get("target_name", ""),
                "item": payload.get("item", "日用品"),
                "quantity": payload.get("quantity", 1),
                "price": payload.get("price", 10.0),
                "reason": payload.get("reason", ""),
            },
            ctx,
        )
    elif action == "propose_vote":
        tool = ProposeVoteTool(world)
        result = await tool.execute(
            {"motion": payload.get("motion", ""), "reason": payload.get("reason", "")},
            ctx,
        )
    else:
        return action or "unknown", "", f"unknown action: {action}"
    thought = str(payload.get("thought", "")).strip()
    return action, thought or result.output, args_json


def _action_from_tool(
    name: str, args_raw: str, thought: str, *, success: bool, detail: str
) -> SimAgentAction:
    tool_args: dict | None = None
    if args_raw:
        try:
            tool_args = json.loads(args_raw)
        except json.JSONDecodeError:
            tool_args = {"raw": args_raw}
    action_kind: Literal[
        "move_to", "stay_here", "speak_to", "propose_trade", "propose_vote", "idle", "error"
    ]
    if name in ("move_to", "stay_here", "speak_to", "propose_trade", "propose_vote"):
        action_kind = name  # type: ignore[assignment]
    elif success:
        action_kind = "idle"
    else:
        action_kind = "error"
    return SimAgentAction(
        agent_id="",
        action=action_kind,
        thought=thought,
        tool_name=name or None,
        tool_args=tool_args,
        success=success,
        detail=detail,
    )


async def run_agent_tick(
    *,
    world: WorldState,
    persona: SimPersona,
    llm,
    run_id: str,
    text_mode: bool = True,
    turn_model: str | None = None,
    workspace_root: Path | None = None,
) -> AgentTickOutcome:
    """Run perception → think → act for one agent on the current tick."""
    sink = RecordingSink()
    tools = ToolRegistry() if text_mode else build_sim_tool_registry(world)
    backend = ServerWorkspace(
        root=workspace_root or Path(tempfile.mkdtemp(prefix="sim-run-")),
        sandbox=SubprocessSandbox(),
    )
    ctx = ToolContext(
        execution_id=new_id(),
        run_id=run_id,
        agent_id=persona.agent_id,
        backend=backend,
        user_id="simulation",
    )
    agent_now = world.agents[persona.agent_id]
    perception = world.perceive(persona.agent_id)
    slot = schedule_hint_for_persona(persona, world.hour)
    perception = f"{perception}\n日程参考（可偏离）：{slot.location} · {slot.activity}"
    memory_block = format_tick_memories_for_perception(agent_now.tick_memories)
    if memory_block:
        perception = f"{perception}\n{memory_block}"
    motivation = MotivationAssessment.evaluate(
        persona,
        MotivationSignals(
            hour=world.hour,
            mood=agent_now.mood,
            money=agent_now.money,
            others_present=len(world.agents_at(agent_now.location, exclude=persona.agent_id)),
            at_home=agent_now.location == "住宅区",
            market_price_multiplier=world.modifiers.market_price_multiplier,
            storm_active=world.modifiers.storm_active,
            festival_active=world.modifiers.festival_active,
        ),
    )
    perception = f"{perception}\n{motivation.hint_line()}"
    messages = _build_messages(persona, perception, text_mode=text_mode)
    model = turn_model or settings.platform_model
    t0 = time.monotonic()
    with log_context(trace_id=new_trace_id(), user_id="simulation", agent=persona.agent_id):
        try:
            content, _reasoning, usage, rounds = await react_loop(
                messages=messages,
                llm=llm,
                tools=tools,
                sink=sink,
                tool_context=ctx,
                profile=_SIM_PROFILE,
                turn_model=model,
                deliverable_only=True,
                role=persona.role,
                run_id=run_id,
                allowed_tool_names=[] if text_mode else None,
            )
            tool_calls = list(sink.tool_calls)
            action_name = ""
            args_json = ""
            thought = content or ""
            success = True
            detail = ""
            if text_mode:
                payload = _parse_action_json(content or "")
                if payload:
                    action_name, thought, args_json = await _apply_parsed_action(
                        world, payload, ctx
                    )
                else:
                    success = False
                    detail = "failed to parse action JSON"
                    action_name = "error"
            elif tool_calls:
                action_name, args_json = tool_calls[0]
            agent = world.agents[persona.agent_id]
            async with world.mutation_lock():
                agent.last_thought = thought
            cost = calculate_cost(model, usage, billing_mode="platform").total
            action = _action_from_tool(
                action_name, args_json, thought, success=success, detail=detail
            )
            action.agent_id = persona.agent_id
            return AgentTickOutcome(
                action=action,
                rounds=rounds,
                latency_ms=int((time.monotonic() - t0) * 1000),
                usage=usage.as_dict(),
                cost_usd=cost / NANO_PER_USD,
            )
        except Exception as e:
            action = SimAgentAction(
                agent_id=persona.agent_id,
                action="error",
                thought="",
                success=False,
                detail=str(e),
            )
            return AgentTickOutcome(
                action=action,
                rounds=0,
                latency_ms=int((time.monotonic() - t0) * 1000),
                usage={},
                cost_usd=0.0,
                error=str(e),
            )
