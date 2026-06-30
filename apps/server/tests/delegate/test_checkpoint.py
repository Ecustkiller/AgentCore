"""Structured checkpoint (plan_review) tests."""

import asyncio

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from tests.delegate.conftest import CKPT_DAG, CKPT_FORK_DAG, Provider, ctx, tool, tool_ckpt


async def _resolve_when_pending(
    registry: InteractionRegistry,
    conversation_id: str,
    decision: CheckpointDecision,
    note: str = "",
):
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


async def test_checkpoint_after_pauses_then_continues():
    registry = InteractionRegistry()
    sink = EventSink()
    t = tool_ckpt(Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(t.execute({"tasks": CKPT_DAG}, ctx()))
    pending = await _resolve_when_pending(registry, "conv1", CheckpointDecision.CONTINUE)
    result = await exec_task

    assert pending.kind.value == "plan_review"
    assert any(s["role"] == "研究员" for s in pending.payload["steps"])
    assert any(p["role"] == "写手" for p in pending.payload["pending"])
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.PLAN_REVIEW_REQUIRED in types
    assert EventType.PLAN_REVIEW_RESOLVED in types


async def test_checkpoint_after_stop_halts_downstream():
    registry = InteractionRegistry()
    sink = EventSink()
    t = tool_ckpt(Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(t.execute({"tasks": CKPT_DAG}, ctx()))
    await _resolve_when_pending(registry, "conv1", CheckpointDecision.STOP)
    result = await exec_task

    assert "S1OUT" in result.output
    assert "S2OUT" not in result.output
    assert "写手" in result.output


async def test_checkpoint_after_adjust_steers_downstream():
    registry = InteractionRegistry()
    sink = EventSink()
    provider = Provider(["S1OUT", "S2OUT"])
    t = tool_ckpt(provider, sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(t.execute({"tasks": CKPT_DAG}, ctx()))
    await _resolve_when_pending(
        registry, "conv1", CheckpointDecision.ADJUST, note="把重点放在风险上"
    )
    result = await exec_task

    assert "S2OUT" in result.output
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "把重点放在风险上" in s2_user
    assert "用户中途调整指示" in s2_user


async def test_checkpoint_adjust_steers_only_dependents_not_parallel_branch():
    registry = InteractionRegistry()
    sink = EventSink()
    provider = Provider(["S1OUT", "U1OUT", "S2OUT", "U2OUT"])
    t = tool_ckpt(provider, sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(t.execute({"tasks": CKPT_FORK_DAG}, ctx()))
    await _resolve_when_pending(
        registry, "conv1", CheckpointDecision.ADJUST, note="把重点放在风险上"
    )
    await exec_task

    def _user_prompt(task_marker: str) -> str:
        return next(
            m.content
            for req in provider.requests
            for m in req.messages
            if m.role == "user" and task_marker in (m.content or "")
        )

    assert "把重点放在风险上" in _user_prompt("撰写")
    assert "把重点放在风险上" not in _user_prompt("付款")


async def test_checkpoint_timeout_continues():
    registry = InteractionRegistry()
    sink = EventSink()
    t = tool_ckpt(Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=0.05)
    result = await t.execute({"tasks": CKPT_DAG}, ctx())
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.PLAN_REVIEW_REQUIRED in types
    assert EventType.PLAN_REVIEW_RESOLVED in types


async def test_checkpoint_inert_when_disabled():
    sink = EventSink()
    t = tool(Provider(["S1OUT", "S2OUT"]), sink=sink)
    result = await t.execute({"tasks": CKPT_DAG}, ctx())
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.PLAN_REVIEW_REQUIRED not in types
