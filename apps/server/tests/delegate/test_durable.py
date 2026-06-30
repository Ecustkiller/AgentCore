"""Durable suspension and resume_plan tests."""

import asyncio

from agentcore.core.types import ToolEffect
from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.types import RunPhase, RunState
from tests.delegate.conftest import (
    CKPT_DAG,
    Provider,
    ctx,
    resume_plan,
    tool,
    tool_durable,
)


async def _resolve_when_pending(registry, conversation_id, decision, note=""):
    from agentcore.runtime.checkpoints import CheckpointResponse

    for _ in range(500):
        pending = registry.list_pending(conversation_id)
        if pending:
            registry.resolve(
                pending[0].id,
                CheckpointResponse(decision=decision, note=note),
                conversation_id=conversation_id,
            )
            return pending[0]
        await asyncio.sleep(0.005)
    raise AssertionError("no pending plan_review appeared")


async def test_durable_pause_persists_frame_on_finalize():
    from agentcore.runtime.suspension import TurnSuspension, captain_transcript

    registry = InteractionRegistry()
    sink = EventSink()
    saved: list[TurnSuspension] = []
    dropped: list[str] = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        dropped.append(mid)

    t = tool_durable(Provider(["S1OUT", "S2OUT"]), sink, registry, _save, _drop)
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
    token = captain_transcript.set(transcript)
    try:
        # ②: the durable checkpoint finalizes in place (SUSPEND) — no live resolve, no drop.
        result = await t.execute({"tasks": CKPT_DAG}, ctx())
    finally:
        captain_transcript.reset(token)

    assert result.effect is ToolEffect.SUSPEND
    assert len(saved) == 1
    frame = saved[0]
    assert frame.message_id == "m1"
    assert frame.conversation_id == "conv1"
    assert frame.captain_run_id == "CEO"
    assert frame.tool_call_id == "call_del"
    assert len(frame.plan.nodes) == 2
    assert frame.completed
    assert any(s["role"] == "研究员" for s in frame.steps)
    assert any(p["role"] == "写手" for p in frame.pending)
    assert any(e["type"] == "plan_review_required" for e in frame.journal)
    assert dropped == []  # finalize never drops the frame — it IS the resume record


async def test_durable_pause_captures_resume_scope():
    # The turn's project scope AND the memory master switch ride the durable frame so a
    # fresh-process resume re-wires consult_memory exactly as this turn did: same project
    # (project 主题 first, then global) and memory-off stays off — Agent记忆与知识系统 §二 /
    # resume folder_id + memory_enabled 缺口.
    from agentcore.runtime.suspension import captain_transcript

    registry = InteractionRegistry()
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        pass

    t = tool_durable(
        Provider(["S1OUT", "S2OUT"]),
        EventSink(),
        registry,
        _save,
        _drop,
        folder_id="proj_42",
        memory_enabled=False,
    )
    transcript = [
        LLMMessage(role="user", content="原始请求"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(id="call_del", function=ToolCallFunction(name="delegate", arguments="{}")),
            ],
        ),
    ]
    token = captain_transcript.set(transcript)
    try:
        await t.execute({"tasks": CKPT_DAG}, ctx())  # ②: finalizes in place
    finally:
        captain_transcript.reset(token)

    assert saved
    assert saved[0].folder_id == "proj_42"
    assert saved[0].memory_enabled is False


async def test_durable_capture_skipped_without_transcript():
    registry = InteractionRegistry()
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        pass

    t = tool_durable(Provider(["S1OUT", "S2OUT"]), EventSink(), registry, _save, _drop)
    exec_task = asyncio.create_task(t.execute({"tasks": CKPT_DAG}, ctx()))
    await _resolve_when_pending(registry, "conv1", CheckpointDecision.CONTINUE)
    await exec_task
    assert saved == []


async def test_durable_resume_drives_tail_from_journal_not_frame():
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from agentcore.runtime.journal import completed_from_journal, plan_from_journal
    from agentcore.runtime.pipeline import _settle_resumed_suspension
    from agentcore.runtime.suspension import (
        PlanReviewSuspension,
        captain_transcript,
        suspension_from_json,
    )

    registry = InteractionRegistry()
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        pass

    pause_tool = tool_durable(Provider(["S1OUT", "S2OUT"]), EventSink(), registry, _save, _drop)
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
    log_token = current_fact_log.set(log)
    ct_token = captain_transcript.set(transcript)
    try:
        await pause_tool.execute({"tasks": CKPT_DAG}, ctx())  # ②: finalizes in place
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(log_token)

    assert saved
    captured = saved[0]

    restored = suspension_from_json(captured.to_json())
    assert isinstance(restored, PlanReviewSuspension)
    assert restored.plan.nodes == []
    assert restored.completed == {}
    restored.journal_entries = list(captured.journal_entries)

    projected_plan = plan_from_journal(restored.journal_entries)
    assert projected_plan is not None and len(projected_plan.nodes) == 2
    assert len(completed_from_journal(restored.journal_entries)) == 1

    resume_sink = EventSink()
    resume_sink.seed_journal(
        [{"type": EventType.PLAN_REVIEW_REQUIRED.value, "payload": {}, "timestamp": "t"}]
    )
    resume_provider = Provider(["S2OUT"])
    resume_tool = tool(resume_provider, resume_sink)
    settled = await _settle_resumed_suspension(
        restored,
        decision=CheckpointDecision.CONTINUE,
        note="",
        selected=[],
        sink=resume_sink,
        delegate_tool=resume_tool,
        execution_id="e_resume",
    )
    assert "S1OUT" in settled.output
    assert "S2OUT" in settled.output
    assert resume_provider.calls == 1


async def test_resume_plan_continue_runs_only_the_tail():
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    t = tool(provider)
    result = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.CONTINUE,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    assert provider.calls == 1


async def test_resume_plan_stop_skips_the_tail():
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["SHOULD_NOT_RUN"])
    t = tool(provider)
    result = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.STOP,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in result.output
    assert "SHOULD_NOT_RUN" not in result.output
    assert provider.calls == 0
    assert "写手" in result.output


async def test_resume_plan_adjust_steers_the_tail():
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    t = tool(provider)
    result = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.ADJUST,
        note="把重点放在风险上",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S2OUT" in result.output
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "把重点放在风险上" in s2_user
