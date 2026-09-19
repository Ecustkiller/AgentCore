"""Drive opens without a team_preview card; leftover frames skip."""

from __future__ import annotations

import asyncio

import pytest

from agentcore.core.types import ToolEffect
from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.coordination.session import (
    active_coordination,
    clear_active_coordination,
)
from agentcore.runtime.delegate.steer import apply_steer
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.facts import TurnFactLog, current_fact_log
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunSpec
from agentcore.runtime.suspension import captain_transcript
from tests.delegate.conftest import Provider, ctx, tool_durable


def _plan(*nodes: RunSpec) -> RunPlan:
    plan = RunPlan()
    for n in nodes:
        plan.add(n)
    return plan


async def test_confirmed_ask_still_suspends_team_preview():
    """journal 已有 checkpoint_resolved 时 ≥2 worker 也不再挂 team_preview。"""
    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    sink.seed_journal(
        [
            {
                "type": EventType.CHECKPOINT_REQUIRED.value,
                "payload": {"checkpoint_id": "ask1"},
                "timestamp": "t0",
            },
            {
                "type": EventType.CHECKPOINT_RESOLVED.value,
                "payload": {"checkpoint_id": "ask1", "decision": "continue"},
                "timestamp": "t1",
            },
        ]
    )
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(_mid):
        pass

    t = tool_durable(Provider(["AOUT", "BOUT"]), sink, registry, _save, _drop)
    transcript = [
        LLMMessage(role="user", content="原始请求"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_del",
                    function=ToolCallFunction(name="delegate", arguments="{}"),
                )
            ],
        ),
    ]
    log = TurnFactLog()
    fl_token = current_fact_log.set(log)
    ct_token = captain_transcript.set(transcript)
    try:
        result = await t.execute(
            {
                "tasks": [
                    {"role": "研究员", "task": "做A"},
                    {"role": "写手", "task": "做B"},
                ],
            },
            ctx(),
        )
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(fl_token)

    assert result.effect is not ToolEffect.SUSPEND
    assert saved == []
    assert not any(str(e.type) == "team_preview_required" for e in sink._history)
    session = active_coordination("e")
    if session is not None and session.drive_task is not None:
        await asyncio.wait_for(session.drive_task, timeout=10)
    clear_active_coordination()


def test_apply_steer_empty_roots_targets_all():
    plan = _plan(
        RunSpec(run_id="r1", task="a", role="A"),
        RunSpec(run_id="r2", task="b", role="B", depends_on=["r1"]),
    )
    apply_steer(plan, {}, set(), "请更简洁")
    assert "请更简洁" in (plan.by_id("r1").steer or "")
    assert "请更简洁" in (plan.by_id("r2").steer or "")


async def test_coordinate_team_preview_suspends_before_fork():
    """coordinate + ≥2 worker：不再先挂编制确认卡，直接臂后台。"""
    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(_mid):
        pass

    t = tool_durable(Provider(["AOUT", "BOUT"]), sink, registry, _save, _drop)
    transcript = [
        LLMMessage(role="user", content="原始请求"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_del",
                    function=ToolCallFunction(name="delegate", arguments="{}"),
                )
            ],
        ),
    ]
    log = TurnFactLog()
    fl_token = current_fact_log.set(log)
    ct_token = captain_transcript.set(transcript)
    try:
        # Default coordinate=True (≥2 workers) — runs without a team_preview card.
        result = await t.execute(
            {
                "tasks": [
                    {"role": "研究员", "task": "做A"},
                    {"role": "写手", "task": "做B"},
                ],
            },
            ctx(),
        )
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(fl_token)

    assert result.effect is not ToolEffect.SUSPEND
    assert "团队已启动" in (result.output or "")
    session = active_coordination("e")
    assert session is not None and session.drive_task is not None
    assert saved == []
    assert not any(str(e.type) == "team_preview_required" for e in sink._history)
    await asyncio.wait_for(session.drive_task, timeout=10)
    clear_active_coordination("e")


async def test_team_preview_continue_then_arms_coordination():
    """顶层 ≥2 worker execute 直接臂协调，无需 team_preview CONTINUE。"""
    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(_mid):
        pass

    t = tool_durable(Provider(["AOUT", "BOUT"]), sink, registry, _save, _drop)
    transcript = [
        LLMMessage(role="user", content="原始请求"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_del",
                    function=ToolCallFunction(name="delegate", arguments="{}"),
                )
            ],
        ),
    ]
    log = TurnFactLog()
    fl_token = current_fact_log.set(log)
    ct_token = captain_transcript.set(transcript)
    try:
        result = await t.execute(
            {
                "tasks": [
                    {"role": "研究员", "task": "做A"},
                    {"role": "写手", "task": "做B"},
                ],
            },
            ctx(),
        )
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(fl_token)

    assert result.effect is not ToolEffect.SUSPEND
    assert saved == []
    assert "团队已启动" in result.output
    session = active_coordination("e")
    assert session is not None and session.drive_task is not None
    await asyncio.wait_for(session.drive_task, timeout=10)
    clear_active_coordination("e")


async def test_leftover_kickoff_frame_skips_hydrate_resume_plan_restores_brief():
    """存量开工卡 from_json 未知 kind；resume_plan 仍可按 kwargs 回灌 team_brief。"""
    from agentcore.runtime.runs import build_run_plan
    from agentcore.runtime.suspension import suspension_from_json

    clear_active_coordination()
    with pytest.raises(ValueError, match="unknown suspension kind"):
        suspension_from_json(
            {
                "kind": "team_preview",
                "message_id": "m1",
                "conversation_id": "conv1",
                "user_id": "u",
                "captain_run_id": "CEO",
                "checkpoint_id": "ck_wall",
                "tool_call_id": "call_del",
                "base_system_prompt": "SYS",
                "user_message": "原始请求",
                "coordination": "wall",
                "team_brief": "统一用中文交付",
            }
        )

    plan, errors = build_run_plan(
        [
            {"role": "观察员", "task": "做A"},
            {"role": "撰稿人", "task": "做B"},
        ],
        valid_tools=set(),
        id_prefix="del_wall_",
        parent_run_id="CEO",
        depth=1,
    )
    assert not errors

    async def _save(_frame):
        return None

    async def _drop(_mid):
        pass

    sink2 = EventSink()
    t2 = tool_durable(Provider(["AOUT", "BOUT"]), sink2, InteractionRegistry(), _save, _drop)
    assert not hasattr(t2, "_coordination")
    resumed = await t2.resume_plan(
        plan,
        {},
        decision=CheckpointDecision.CONTINUE,
        note="",
        checkpoint_run_ids=set(),
        execution_id="e",
        coordinate=False,
        team_brief="统一用中文交付",
    )
    assert resumed.success is True
    assert t2._team_brief == "统一用中文交付"
    assert not any(str(e.type) == "team_note_posted" for e in sink2._history)  # noqa: SLF001
    clear_active_coordination()
