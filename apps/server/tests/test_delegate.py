"""Tests for DelegateTool (统一 Run 模型 阶段3, Option 1 非-terminal).

Drives the tool end to end with a scripted fake provider (no network): it builds
a RunPlan from inline-role tasks, runs the workers through the WaveScheduler, and
returns their products to the CEO as a **non-terminal** result (so the CEO
synthesizes the final answer itself). Also covers rejection of bad task batches,
worker token accumulation, and the graph lifecycle events.
"""

import json
from pathlib import Path

from agentcore.core.types import ToolEffect
from agentcore.llm.protocol import LLMChunk, TokenUsage, ToolCallDelta
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.types import RunPhase, RunState
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _Provider:
    """Fake LLM: one scripted content chunk per call, optionally a usage chunk."""

    def __init__(self, contents: list[str], usage: TokenUsage | None = None) -> None:
        self._contents = contents
        self._usage = usage
        self.calls = 0

    async def stream(self, request):
        text = self._contents[self.calls] if self.calls < len(self._contents) else "done"
        self.calls += 1
        yield LLMChunk(delta_content=text)
        if self._usage is not None:
            yield LLMChunk(usage=self._usage)


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _tool(provider: _Provider, sink: EventSink | None = None) -> DelegateTool:
    return DelegateTool(
        llm=provider,
        sink=sink or EventSink(),
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
    )


async def test_parallel_delegate_returns_products_non_terminal():
    tool = _tool(_Provider(["AOUT", "BOUT"]))
    result = await tool.execute(
        {"tasks": [{"role": "研究员", "task": "做A"}, {"role": "写手", "task": "做B"}]}, _ctx()
    )
    assert result.success is True
    assert result.is_terminal is False
    assert "AOUT" in result.output
    assert "BOUT" in result.output
    assert "研究员" in result.output
    assert "写手" in result.output
    assert set(result.metadata) == {
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_hit_tokens",
        "cache_miss_tokens",
    }


async def test_dag_delegate_completes_with_both_products():
    tasks = [
        {"id": "s1", "role": "研究员", "task": "调研"},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    tool = _tool(_Provider(["UPSTREAM", "FINAL"]))
    result = await tool.execute({"tasks": tasks}, _ctx())
    assert result.success is True
    assert result.is_terminal is False
    assert "UPSTREAM" in result.output
    assert "FINAL" in result.output


async def test_finalize_single_worker_surfaces_directly_as_terminal():
    # 提案2a: a single self-contained deliverable the CEO finalized is surfaced
    # directly — HANDOFF terminal (no CEO synthesis round), the worker's product is
    # the final_text, and it is streamed to the chat bubble (content_delta).
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=0,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    sink = EventSink()
    tool = _tool(_Provider(["DIRECT"], usage=usage), sink=sink)
    result = await tool.execute(
        {"tasks": [{"role": "工程师", "task": "建文件"}], "finalize": True}, _ctx()
    )
    assert result.success is True
    assert result.is_terminal is True
    assert result.effect is ToolEffect.HANDOFF
    assert result.final_text == "DIRECT"
    # Worker usage is tracked on the instance (the pipeline folds it into the turn
    # total) but NOT echoed in metadata — otherwise the engine's terminal path would
    # double-count it into the captain's own spend.
    assert tool.usage["input"] == 10
    assert "input_tokens" not in result.metadata
    # final_text is persisted but not re-emitted by the engine, so the product is
    # streamed to the chat bubble here (the only content_delta — worker output rides
    # run_output_delta, not the bubble).
    sink.close()
    deltas = [
        e.payload["delta"] async for e in sink if e.type == EventType.CONTENT_DELTA
    ]
    assert deltas == ["DIRECT"]


async def test_finalize_ignored_for_multi_worker_batch():
    # finalize only collapses a single-worker delivery; a multi-worker batch still
    # needs the CEO to weave the products, so it stays non-terminal.
    tool = _tool(_Provider(["A", "B"]))
    result = await tool.execute(
        {
            "tasks": [{"role": "A", "task": "a"}, {"role": "B", "task": "b"}],
            "finalize": True,
        },
        _ctx(),
    )
    assert result.is_terminal is False
    assert "A" in result.output and "B" in result.output


async def test_finalize_falls_back_to_synthesis_when_worker_fails():
    # finalize is safe: if the single worker hard-fails its contract, we do NOT
    # surface a failure as the final answer — fall back to the non-terminal path so
    # the CEO can react and wrap up.
    tool = _tool(_Provider(["X"]))  # length 1, fails the min_length contract below
    result = await tool.execute(
        {
            "tasks": [
                {
                    "role": "A",
                    "task": "a",
                    "contract": {"min_length": 100, "strict": True},
                }
            ],
            "finalize": True,
        },
        _ctx(),
    )
    assert result.is_terminal is False


async def test_empty_tasks_rejected():
    tool = _tool(_Provider([]))
    result = await tool.execute({"tasks": []}, _ctx())
    assert result.success is False
    assert result.is_terminal is False
    assert result.error


async def test_all_invalid_tasks_rejected():
    tool = _tool(_Provider([]))
    result = await tool.execute({"tasks": [{"role": "A"}]}, _ctx())  # missing task
    assert result.success is False
    assert result.error


async def test_worker_usage_accumulates_across_calls():
    # The cache hit/miss split rides along with the basic counts so the folded
    # turn total stays priceable.
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=2,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    tool = _tool(_Provider(["X", "Y", "Z", "W"], usage=usage))
    first = await tool.execute({"tasks": [{"role": "A", "task": "a"}]}, _ctx())
    assert first.metadata["input_tokens"] == 10
    assert first.metadata["cache_hit_tokens"] == 6
    assert tool.usage == {
        "input": 10,
        "output": 5,
        "reasoning": 2,
        "cache_hit": 6,
        "cache_miss": 4,
    }
    await tool.execute({"tasks": [{"role": "B", "task": "b"}]}, _ctx())
    assert tool.usage == {
        "input": 20,
        "output": 10,
        "reasoning": 4,
        "cache_hit": 12,
        "cache_miss": 8,
    }


async def test_emits_plan_and_lifecycle_events():
    sink = EventSink()
    tool = _tool(_Provider(["X"]), sink=sink)
    await tool.execute({"tasks": [{"role": "A", "task": "做A"}]}, _ctx())
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.RUN_PLAN in types
    assert EventType.RUN_STARTED in types
    assert EventType.RUN_COMPLETED in types
    assert EventType.RUN_PROGRESS in types


async def test_run_plan_carries_stance_and_group_tags():
    # 辩论/审查 (前端UX目标态 §四②): the CEO marks an opposing batch; the tags ride the
    # run_plan payload display-only so the frontend can render正反 side-by-side. The
    # execution stays a普通并行 DAG (守住「形状是数据不是模式」) — only the wire grew.
    sink = EventSink()
    tool = _tool(_Provider(["PRO", "CON"]), sink=sink)
    await tool.execute(
        {
            "tasks": [
                {"role": "正方", "task": "支持", "stance": "pro", "group": "g1"},
                {"role": "反方", "task": "反对", "stance": "con", "group": "g1"},
            ]
        },
        _ctx(),
    )
    sink.close()
    plan_runs = [
        r async for e in sink if e.type == EventType.RUN_PLAN for r in e.payload["runs"]
    ]
    by_task = {r["task"]: r for r in plan_runs}
    assert by_task["支持"]["stance"] == "pro"
    assert by_task["支持"]["group"] == "g1"
    assert by_task["反对"]["stance"] == "con"
    assert by_task["反对"]["group"] == "g1"


async def test_run_plan_carries_round_tag():
    # 真·多轮辩论 (前端UX目标态 §四): round rides run_plan display-only alongside
    # stance/group so the frontend can lay rounds out 逐轮. 跨轮交锋全靠 depends_on —
    # round 只是呈现信号, 不改执行 (守住「形状是数据不是模式」).
    sink = EventSink()
    tool = _tool(_Provider(["R1", "R2"]), sink=sink)
    await tool.execute(
        {
            "tasks": [
                {"id": "p1", "role": "正方", "task": "首轮", "stance": "pro", "round": 1},
                {
                    "id": "p2",
                    "role": "正方",
                    "task": "次轮",
                    "stance": "pro",
                    "round": 2,
                    "depends_on": ["p1"],
                },
            ]
        },
        _ctx(),
    )
    sink.close()
    plan_runs = [
        r async for e in sink if e.type == EventType.RUN_PLAN for r in e.payload["runs"]
    ]
    by_task = {r["task"]: r for r in plan_runs}
    assert by_task["首轮"]["round"] == 1
    assert by_task["次轮"]["round"] == 2


async def test_run_plan_omits_tags_for_ordinary_batch():
    # An untagged batch must not grow new keys — the common parallel/DAG path stays
    # byte-identical, so only a real debate carries the presentation hint.
    sink = EventSink()
    tool = _tool(_Provider(["X", "Y"]), sink=sink)
    await tool.execute(
        {"tasks": [{"role": "A", "task": "a"}, {"role": "B", "task": "b"}]}, _ctx()
    )
    sink.close()
    plan_runs = [
        r async for e in sink if e.type == EventType.RUN_PLAN for r in e.payload["runs"]
    ]
    assert plan_runs  # sanity: the batch was declared
    assert all(
        "stance" not in r and "group" not in r and "round" not in r
        for r in plan_runs
    )


def test_task_description_matches_what_worker_actually_receives():
    # The worker's user message carries a separate 原始用户请求 block
    # (executor._build_messages), so the task field must NOT claim the worker
    # "只收到这段" — that old wording pushed the CEO to redundantly re-embed the
    # request. Pin the accurate framing so it can't silently regress.
    tool = _tool(_Provider([]))
    task_desc = tool.schema.parameters["properties"]["tasks"]["items"]["properties"]["task"][
        "description"
    ]
    assert "原始用户请求" in task_desc
    assert "只收到这段" not in task_desc


def test_strict_description_separates_rework_from_disposition():
    # 返工一次是无条件的（DEFAULT_CONTRACT_RETRIES, executor），strict 只决定「返工后
    # 仍不达标」的处置：硬退 vs 软提醒。旧文案「true=不达标必须返工」把返工错绑到 strict 上，
    # 还与顶层「自动返工一次」自相矛盾。钉住对齐后的措辞，防止再次回归。
    tool = _tool(_Provider([]))
    contract_props = tool.schema.parameters["properties"]["tasks"]["items"]["properties"][
        "contract"
    ]
    strict_desc = contract_props["properties"]["strict"]["description"]
    assert "硬退" in strict_desc
    assert "软" in strict_desc
    assert "必须返工" not in strict_desc  # 返工无条件，不由 strict 决定
    # 顶层 contract 描述讲同一个故事：先无条件返工一次，再由 strict 决定硬退 / 软提醒。
    contract_desc = contract_props["description"]
    assert "自动返工一次" in contract_desc
    assert "硬退" in contract_desc


# --- local-mode worker gating (双模式工作区 P2d 执行门) ----------------------
#
# The same per-turn ApprovalGate is forwarded to workers ONLY when the backend is
# local (a worker would touch the user's real machine); in cloud it is withheld
# (isolated sandbox). We capture the gate handed to build_agent_executor.


class _LocalBackend:
    """Minimal local backend stub — DelegateTool only reads ``.location``."""

    location = "local"
    root_label = "ws"


def _local_ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=_LocalBackend(),
        user_id="u",
    )


def _capture_gate(monkeypatch) -> dict:
    """Patch build_agent_executor to record the approval_gate it was handed."""
    captured: dict = {}

    def fake_build(**kwargs):
        captured["gate"] = kwargs.get("approval_gate")

        async def _exec(spec, completed):  # noqa: ANN001 - duck-typed RunExecutor
            return RunState(phase=RunPhase.COMPLETED, content="X")

        return _exec

    monkeypatch.setattr("agentcore.runtime.runs.build_agent_executor", fake_build)
    return captured


def _gate() -> ApprovalGate:
    return ApprovalGate(
        sink=EventSink(),
        conversation_id="c",
        registry=InteractionRegistry(),
        timeout_seconds=1.0,
    )


def _tool_with_gate(ctx: ToolContext, gate: ApprovalGate) -> DelegateTool:
    return DelegateTool(
        llm=_Provider(["X"]),
        sink=EventSink(),
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=ctx,
        approval_gate=gate,
    )


async def test_workers_gated_in_local_mode(monkeypatch):
    captured = _capture_gate(monkeypatch)
    gate = _gate()
    tool = _tool_with_gate(_local_ctx(), gate)
    await tool.execute({"tasks": [{"role": "A", "task": "a"}]}, _local_ctx())
    # Local: the worker team inherits the CEO's gate (consent before touching disk).
    assert captured["gate"] is gate


async def test_workers_ungated_in_cloud_mode(monkeypatch):
    captured = _capture_gate(monkeypatch)
    tool = _tool_with_gate(_ctx(), _gate())  # _ctx() is a server (cloud) backend
    await tool.execute({"tasks": [{"role": "A", "task": "a"}]}, _ctx())
    # Cloud: workers stay un-gated (isolated sandbox) — gate withheld.
    assert captured["gate"] is None


async def test_second_call_namespaces_run_ids():
    sink = EventSink()
    tool = _tool(_Provider(["X", "Y"]), sink=sink)
    await tool.execute({"tasks": [{"role": "A", "task": "a"}]}, _ctx())
    await tool.execute({"tasks": [{"role": "B", "task": "b"}]}, _ctx())
    sink.close()
    starts = [e async for e in sink if e.type == EventType.RUN_STARTED]
    run_ids = [e.payload["run_id"] for e in starts]
    assert len(run_ids) == 2
    assert run_ids[0] != run_ids[1]  # distinct namespacing across delegate calls


# --- 阶段2 嵌套子任务: one nested delegation level, end to end -----------------
#
# A worker that opted in (can_delegate) leads its own sub-team. We drive the whole
# path with a content-aware fake: the captain worker (the only run carrying the
# captain identity) delegates a 2-worker sub-team on its first call and integrates
# on its second; leaf / sub workers just emit content.


class _NestingProvider:
    """Fake LLM driving exactly one nested level (no network).

    Branches on the request's worker identity (the captain preamble appears only
    for an opted-in, above-cap worker) and whether the sub-team already returned:
    captain + no result → emit a ``delegate`` tool call; captain + result → emit
    the integrated final; anyone else → plain content. Yields a usage chunk per
    call so the usage/ledger roll-up is observable."""

    CAPTAIN_MARK = "再向下委派一层子团队"  # unique to executor._WORKER_CAPTAIN_IDENTITY

    def __init__(self, usage: TokenUsage | None = None) -> None:
        self._usage = usage
        self.delegate_calls = 0

    async def stream(self, request):
        system = next((m.content or "" for m in request.messages if m.role == "system"), "")
        is_captain = self.CAPTAIN_MARK in system
        has_result = any(m.role == "tool" for m in request.messages)
        if is_captain and not has_result:
            self.delegate_calls += 1
            args = json.dumps(
                {
                    "tasks": [
                        {"role": "子研究员", "task": "子任务A"},
                        {"role": "子写手", "task": "子任务B"},
                    ]
                }
            )
            yield LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0, id="sub-tc", function_name="delegate", arguments_delta=args
                    )
                ]
            )
        elif is_captain:
            yield LLMChunk(delta_content="CAPTAIN_FINAL")
        else:
            yield LLMChunk(delta_content="SUBOUT")
        if self._usage is not None:
            yield LLMChunk(usage=self._usage)


def _nesting_tool(provider: _NestingProvider, sink: EventSink) -> DelegateTool:
    # captain_run_id="CEO": the top-level (depth-0) tool stands in for the CEO, so
    # depth-1 workers are parented to "CEO" and sub-workers to their worker.
    return DelegateTool(
        llm=provider,
        sink=sink,
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
        captain_run_id="CEO",
    )


async def test_nested_delegation_runs_subteam_links_tree_and_rolls_up():
    sink = EventSink()
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=0,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    provider = _NestingProvider(usage=usage)
    tool = _nesting_tool(provider, sink)

    result = await tool.execute(
        {"tasks": [{"role": "队长", "task": "主任务", "can_delegate": True}]}, _ctx()
    )

    assert result.success is True
    assert result.is_terminal is False
    # The captain worker delegated exactly one nested sub-team.
    assert provider.delegate_calls == 1
    # The CEO sees the captain worker's integrated answer; the sub-workers' raw
    # outputs are folded by that worker, not re-surfaced to the CEO.
    assert "CAPTAIN_FINAL" in result.output

    # Tree linkage (run_started.parent_run_id): one depth-1 captain worker parented
    # to the CEO root, two depth-2 sub-workers parented to that worker.
    sink.close()
    events = [e async for e in sink]
    starts = [e for e in events if e.type == EventType.RUN_STARTED]
    by_parent: dict[str | None, list[str]] = {}
    for e in starts:
        by_parent.setdefault(e.payload["parent_run_id"], []).append(e.payload["run_id"])
    assert len(by_parent["CEO"]) == 1
    cap_id = by_parent["CEO"][0]
    assert len(by_parent[cap_id]) == 2

    # The graph groups a sub-team structurally from run_plan (not just run_started):
    # the nested batch pre-declares each sub-worker's parent_run_id = the captain
    # worker's run, so the frontend can lay the sub-team out under the parent before
    # the sub-workers even start.
    plan_runs = [
        r for e in events if e.type == EventType.RUN_PLAN for r in e.payload["runs"]
    ]
    parents = {r["id"]: r["parent_run_id"] for r in plan_runs}
    assert parents[cap_id] == "CEO"
    assert all(parents[sub_id] == cap_id for sub_id in by_parent[cap_id])

    # Usage rolls up the WHOLE tree: captain worker 2 LLM calls + 2 sub-workers ×
    # 1 call = 4 metered calls (× 10 input, × 5 output each).
    assert tool.usage["input"] == 40
    assert tool.usage["output"] == 20
    assert tool.usage["cache_hit"] == 24

    # Ledger: one member row for the captain worker (parent=CEO) + two sub-worker
    # rows (parent=captain worker) — a reconstructable run tree.
    assert len(tool.run_ledger) == 3
    cap_rows = [r for r in tool.run_ledger if r.parent_run_id == "CEO"]
    sub_rows = [r for r in tool.run_ledger if r.parent_run_id == cap_id]
    assert len(cap_rows) == 1
    assert cap_rows[0].run_id == cap_id
    assert len(sub_rows) == 2


async def test_depth_two_subworker_cannot_delegate_further():
    # Even if the captain worker marks its sub-task can_delegate=true, a depth-2
    # sub-worker is at the cap and never receives a delegate tool — so the tree can
    # never nest past CEO → worker → sub-worker. The sub-worker carries the leaf
    # identity and just produces content; total delegations stay at one.
    class _DeepProvider(_NestingProvider):
        async def stream(self, request):
            system = next(
                (m.content or "" for m in request.messages if m.role == "system"), ""
            )
            is_captain = self.CAPTAIN_MARK in system
            has_result = any(m.role == "tool" for m in request.messages)
            if is_captain and not has_result:
                self.delegate_calls += 1
                # The captain tries to grant its sub-worker the nesting flag.
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

    provider = _DeepProvider()
    tool = _nesting_tool(provider, EventSink())
    result = await tool.execute(
        {"tasks": [{"role": "队长", "task": "主任务", "can_delegate": True}]}, _ctx()
    )
    assert result.success is True
    # Only the depth-1 captain delegated; the depth-2 sub-worker was a leaf despite
    # its can_delegate flag (the depth cap withheld the tool), so no second nest.
    assert provider.delegate_calls == 1


def test_collect_citations_folds_completed_workers_deduped_excludes_failed():
    # 方案 B: the workers' web sources reach the turn's shared card via the delegate
    # tool. Only COMPLETED runs contribute (a hard-failed worker's output is
    # discarded, so its sources don't back the answer), and a page two workers both
    # found collapses to one card (normalized-url dedup).
    tool = _tool(_Provider([]))
    a = {"url": "https://a.com", "title": "A"}
    b = {"url": "https://b.com", "title": "B"}
    results = {
        "r1": RunState(phase=RunPhase.COMPLETED, content="x", citations=[a, b]),
        # same page (trailing fragment) from another completed worker → dedups
        "r2": RunState(
            phase=RunPhase.COMPLETED,
            content="y",
            citations=[{"url": "https://a.com/#frag", "title": "A again"}],
        ),
        # a hard-failed worker's source must NOT surface (its output is discarded)
        "r3": RunState(
            phase=RunPhase.FAILED,
            content="z",
            citations=[{"url": "https://secret.com", "title": "S"}],
        ),
    }
    tool._collect_citations(results)
    assert [c["url"] for c in tool.citations] == ["https://a.com", "https://b.com"]
