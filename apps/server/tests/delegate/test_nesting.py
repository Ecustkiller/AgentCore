"""Nested delegation tests."""

import json

from agentcore.llm.protocol import LLMChunk, TokenUsage, ToolCallDelta
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs.types import RunPhase, RunState
from tests.delegate.conftest import NestingProvider, Provider, ctx, nesting_tool, tool


async def test_nested_delegation_runs_subteam_links_tree_and_rolls_up():
    sink = EventSink()
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=0,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    provider = NestingProvider(usage=usage)
    t = nesting_tool(provider, sink)

    result = await t.execute(
        {"tasks": [{"role": "队长", "task": "主任务", "can_delegate": True}]}, ctx()
    )

    assert result.success is True
    assert result.is_terminal is False
    assert provider.delegate_calls == 1
    assert "CAPTAIN_FINAL" in result.output

    sink.close()
    events = [e async for e in sink]
    starts = [e for e in events if e.type == EventType.RUN_STARTED]
    by_parent: dict[str | None, list[str]] = {}
    for e in starts:
        by_parent.setdefault(e.payload["parent_run_id"], []).append(e.payload["run_id"])
    assert len(by_parent["CEO"]) == 1
    cap_id = by_parent["CEO"][0]
    assert len(by_parent[cap_id]) == 2

    plan_runs = [r for e in events if e.type == EventType.RUN_PLAN for r in e.payload["runs"]]
    parents = {r["id"]: r["parent_run_id"] for r in plan_runs}
    assert parents[cap_id] == "CEO"
    assert all(parents[sub_id] == cap_id for sub_id in by_parent[cap_id])

    assert t.usage["input"] == 40
    assert t.usage["output"] == 20
    assert t.usage["cache_hit"] == 24

    assert len(t.run_ledger) == 3
    cap_rows = [r for r in t.run_ledger if r.parent_run_id == "CEO"]
    sub_rows = [r for r in t.run_ledger if r.parent_run_id == cap_id]
    assert len(cap_rows) == 1
    assert cap_rows[0].run_id == cap_id
    assert len(sub_rows) == 2


async def test_depth_two_subworker_cannot_delegate_further():
    class DeepProvider(NestingProvider):
        async def stream(self, request):
            system = next((m.content or "" for m in request.messages if m.role == "system"), "")
            is_captain = self.CAPTAIN_MARK in system
            has_result = any(m.role == "tool" for m in request.messages)
            if is_captain and not has_result:
                self.delegate_calls += 1
                args = json.dumps(
                    {"tasks": [{"role": "子队长", "task": "子任务", "can_delegate": True}]}
                )
                yield LLMChunk(
                    delta_tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="sub-tc",
                            function_name="delegate",
                            arguments_delta=args,
                        )
                    ]
                )
            elif is_captain:
                yield LLMChunk(delta_content="CAPTAIN_FINAL")
            else:
                yield LLMChunk(delta_content="SUBOUT")

    provider = DeepProvider()
    t = nesting_tool(provider, EventSink())
    result = await t.execute(
        {"tasks": [{"role": "队长", "task": "主任务", "can_delegate": True}]}, ctx()
    )
    assert result.success is True
    assert provider.delegate_calls == 1


def test_collect_citations_folds_completed_workers_deduped_excludes_failed():
    t = tool(Provider([]))
    a = {"url": "https://a.com", "title": "A"}
    b = {"url": "https://b.com", "title": "B"}
    results = {
        "r1": RunState(phase=RunPhase.COMPLETED, content="x", citations=[a, b]),
        "r2": RunState(
            phase=RunPhase.COMPLETED,
            content="y",
            citations=[{"url": "https://a.com/#frag", "title": "A again"}],
        ),
        "r3": RunState(
            phase=RunPhase.FAILED,
            content="z",
            citations=[{"url": "https://secret.com", "title": "S"}],
        ),
    }
    t._collect_citations(results)
    assert [c["url"] for c in t.citations] == ["https://a.com", "https://b.com"]
