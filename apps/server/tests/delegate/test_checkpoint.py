"""Retired DAG checkpoint_after: extra key does not pause the plan."""

from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import InteractionRegistry
from tests.delegate.conftest import CKPT_DAG, Provider, ctx, tool, tool_ckpt


async def test_checkpoint_after_extra_key_does_not_pause():
    """多余键 checkpoint_after 不挂起；两 worker 都跑完。"""
    registry = InteractionRegistry()
    sink = EventSink()
    t = tool_ckpt(Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=5.0)
    result = await t.execute({"tasks": CKPT_DAG, "coordinate": False}, ctx())

    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    assert registry.list_pending("conv1") == []
    sink.close()
    types = [e.type async for e in sink]
    assert "plan_review_required" not in {str(t) for t in types}


async def test_checkpoint_inert_when_disabled():
    sink = EventSink()
    t = tool(Provider(["S1OUT", "S2OUT"]), sink=sink)
    result = await t.execute({"tasks": CKPT_DAG, "coordinate": False}, ctx())
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
