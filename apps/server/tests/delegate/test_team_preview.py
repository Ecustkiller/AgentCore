"""Unit tests for the thin team_preview gate (方案 A)."""

from __future__ import annotations

from types import SimpleNamespace

from agentcore.core.types import ToolEffect
from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.coordination.session import (
    active_coordination,
    clear_active_coordination,
)
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.facts import TurnFactLog, current_fact_log
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunSpec
from agentcore.runtime.suspension import TeamPreviewSuspension, captain_transcript
from agentcore.tools.builtin.delegate.preview import (
    should_preview,
    skip_after_confirmed_ask,
    worker_rows,
)
from agentcore.tools.builtin.delegate.steer import apply_steer
from tests.delegate.conftest import Provider, ctx, tool_durable


def _plan(*nodes: RunSpec) -> RunPlan:
    plan = RunPlan()
    for n in nodes:
        plan.add(n)
    return plan


def test_should_preview_multi_worker():
    plan = _plan(
        RunSpec(run_id="r1", task="a", role="调研"),
        RunSpec(run_id="r2", task="b", role="撰写", depends_on=["r1"]),
    )
    assert should_preview(plan, finalize=False) is True
    assert should_preview(plan, finalize=True) is True


def test_should_preview_skips_solo_finalize():
    plan = _plan(RunSpec(run_id="r1", task="alone", role="写手"))
    assert should_preview(plan, finalize=True) is False
    assert should_preview(plan, finalize=False) is False


def test_should_preview_debate_marked_solo():
    plan = _plan(RunSpec(run_id="r1", task="辩", role="正方", stance="pro", round=1))
    assert should_preview(plan, finalize=True) is True


def test_skip_after_confirmed_ask():
    tool = SimpleNamespace(
        _sink=SimpleNamespace(
            execution_journal=lambda: [
                {"type": "checkpoint_required", "payload": {}},
                {"type": "checkpoint_resolved", "payload": {"decision": "continue"}},
            ]
        )
    )
    assert skip_after_confirmed_ask(tool) is True
    tool_nb = SimpleNamespace(
        _sink=SimpleNamespace(
            execution_journal=lambda: [{"type": "question_posted", "payload": {}}]
        )
    )
    assert skip_after_confirmed_ask(tool_nb) is False
    tool_empty = SimpleNamespace(_sink=SimpleNamespace(execution_journal=lambda: None))
    assert skip_after_confirmed_ask(tool_empty) is False


def test_worker_rows_shape():
    plan = _plan(
        RunSpec(run_id="r1", task="调研方案", role="调研"),
        RunSpec(run_id="r2", task="写", role="撰写", depends_on=["r1"], stance="con"),
    )
    rows = worker_rows(plan)
    assert rows[0]["role"] == "调研"
    assert rows[0]["debate"] is False
    assert rows[1]["depends_on"] == ["r1"]
    assert rows[1]["debate"] is True


def test_apply_steer_empty_roots_targets_all():
    plan = _plan(
        RunSpec(run_id="r1", task="a", role="A"),
        RunSpec(run_id="r2", task="b", role="B", depends_on=["r1"]),
    )
    apply_steer(plan, {}, set(), "请更简洁")
    assert "请更简洁" in (plan.by_id("r1").steer or "")
    assert "请更简洁" in (plan.by_id("r2").steer or "")


async def test_coordinate_team_preview_suspends_before_fork():
    """coordinate + team_preview: durable pause is on the CEO path before the fork.

    CEO gets SUSPEND (so message_end(paused) / ResumePrompt can fire); no background
    coordination session is armed until the user CONTINUEs.
    """
    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list[TeamPreviewSuspension] = []

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
        # Default coordinate=True (≥2 workers) — must NOT fork before preview settles.
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

    assert result.effect is ToolEffect.SUSPEND
    assert "团队已启动" not in (result.output or "")
    assert active_coordination("e") is None
    assert len(saved) == 1
    assert isinstance(saved[0], TeamPreviewSuspension)
    assert len(saved[0].workers) == 2
    assert any(e.type is EventType.TEAM_PREVIEW_REQUIRED for e in sink._history)
    clear_active_coordination()


async def test_team_preview_continue_then_arms_coordination():
    """After durable team_preview CONTINUE, resume_plan(coordinate=True) arms the background."""
    import asyncio

    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list[TeamPreviewSuspension] = []

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
        pause = await t.execute(
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

    assert pause.effect is ToolEffect.SUSPEND
    frame = saved[0]
    resumed = await t.resume_plan(
        frame.plan,
        dict(frame.completed),
        decision=CheckpointDecision.CONTINUE,
        note="",
        checkpoint_run_ids=frame.checkpoint_run_ids,
        execution_id="e",
        coordinate=True,
    )
    assert resumed.success is True
    assert "团队已启动" in resumed.output
    session = active_coordination("e")
    assert session is not None and session.drive_task is not None
    await asyncio.wait_for(session.drive_task, timeout=10)
    clear_active_coordination("e")
