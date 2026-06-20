"""Tests for DelegateTool (统一 Run 模型 阶段3, Option 1 非-terminal).

Drives the tool end to end with a scripted fake provider (no network): it builds
a RunPlan from inline-role tasks, runs the workers through the WaveScheduler, and
returns their products to the CEO as a **non-terminal** result (so the CEO
synthesizes the final answer itself). Also covers rejection of bad task batches,
worker token accumulation, and the graph lifecycle events.
"""

import asyncio
import json
from pathlib import Path

from agentcore.core.types import ToolEffect
from agentcore.llm.protocol import LLMChunk, TokenUsage, ToolCallDelta
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _Provider:
    """Fake LLM: one scripted content chunk per call, optionally a usage chunk.

    Records each ``LLMRequest`` it is handed (``requests``) so a test can assert on
    the assembled worker prompt (e.g. an injected steer)."""

    def __init__(self, contents: list[str], usage: TokenUsage | None = None) -> None:
        self._contents = contents
        self._usage = usage
        self.calls = 0
        self.requests: list = []

    async def stream(self, request):
        self.requests.append(request)
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
    # 辩论/审查 (前端UX设计.md §四②): the CEO marks an opposing batch; the tags ride the
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
    # 真·多轮辩论 (前端UX设计.md §四): round rides run_plan display-only alongside
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


# --- 结构化挂起 2a: checkpoint_after wave-boundary suspend (end-to-end) -----------


def _tool_ckpt(
    provider: _Provider,
    sink: EventSink,
    registry: InteractionRegistry,
    conversation_id: str,
    *,
    timeout: float,
) -> DelegateTool:
    """A delegate tool wired for structured checkpoints (gate on + bridge + conv)."""
    return DelegateTool(
        llm=provider,
        sink=sink,
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
        conversation_id=conversation_id,
        registry=registry,
        checkpoint_timeout_seconds=timeout,
        checkpoint_enabled=True,
    )


async def _resolve_when_pending(
    registry: InteractionRegistry,
    conversation_id: str,
    decision: CheckpointDecision,
    note: str = "",
):
    """Poll the bridge for the paused plan_review and settle it (mimics the user)."""
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


_CKPT_DAG = [
    {"id": "s1", "role": "研究员", "task": "调研", "checkpoint_after": True},
    {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
]


async def test_checkpoint_after_pauses_then_continues():
    # s1 (checkpoint_after) → s2: the scheduler pauses after s1, the user continues,
    # and s2 then runs. Both products come back; the pause + resolution are emitted.
    registry = InteractionRegistry()
    sink = EventSink()
    tool = _tool_ckpt(_Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(tool.execute({"tasks": _CKPT_DAG}, _ctx()))
    pending = await _resolve_when_pending(registry, "conv1", CheckpointDecision.CONTINUE)
    result = await exec_task

    assert pending.kind.value == "plan_review"
    # The review card framed s1 (just finished) and s2 (about to run).
    assert any(s["role"] == "研究员" for s in pending.payload["steps"])
    assert any(p["role"] == "写手" for p in pending.payload["pending"])
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.PLAN_REVIEW_REQUIRED in types
    assert EventType.PLAN_REVIEW_RESOLVED in types


async def test_checkpoint_after_stop_halts_downstream():
    # Stopping at the checkpoint ends the run: s1 is kept, s2 never runs.
    registry = InteractionRegistry()
    sink = EventSink()
    tool = _tool_ckpt(_Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(tool.execute({"tasks": _CKPT_DAG}, _ctx()))
    await _resolve_when_pending(registry, "conv1", CheckpointDecision.STOP)
    result = await exec_task

    assert "S1OUT" in result.output
    assert "S2OUT" not in result.output  # downstream halted
    # s2 shows as un-run in the CEO summary rather than a product.
    assert "写手" in result.output


async def test_checkpoint_after_adjust_steers_downstream():
    # Adjusting at the checkpoint injects the user's note as a steer onto the
    # not-yet-run downstream step, then proceeds: s2 still runs AND its prompt
    # carries the steer so the correction redirects the remaining work.
    registry = InteractionRegistry()
    sink = EventSink()
    provider = _Provider(["S1OUT", "S2OUT"])
    tool = _tool_ckpt(provider, sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(tool.execute({"tasks": _CKPT_DAG}, _ctx()))
    await _resolve_when_pending(
        registry, "conv1", CheckpointDecision.ADJUST, note="把重点放在风险上"
    )
    result = await exec_task

    assert "S2OUT" in result.output  # adjust proceeds (unlike stop)
    # The downstream worker's prompt carries the injected steer block.
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "把重点放在风险上" in s2_user
    assert "用户中途调整指示" in s2_user


_CKPT_FORK_DAG = [
    {"id": "s1", "role": "研究员", "task": "调研", "checkpoint_after": True},
    {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    {"id": "u1", "role": "采购", "task": "比价"},
    {"id": "u2", "role": "出纳", "task": "付款", "depends_on": ["u1"]},
]


async def test_checkpoint_adjust_steers_only_dependents_not_parallel_branch():
    # s1 (checkpoint) → s2, with an INDEPENDENT chain u1 → u2 running alongside. At the
    # pause u2 is still pending but does NOT depend on s1, so an adjust steer must reach
    # s2 (the reviewed output's dependent) and leave the unrelated u2 untouched
    # (避免污染无关并行支).
    registry = InteractionRegistry()
    sink = EventSink()
    provider = _Provider(["S1OUT", "U1OUT", "S2OUT", "U2OUT"])
    tool = _tool_ckpt(provider, sink, registry, "conv1", timeout=5.0)
    exec_task = asyncio.create_task(tool.execute({"tasks": _CKPT_FORK_DAG}, _ctx()))
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

    assert "把重点放在风险上" in _user_prompt("撰写")  # s2 depends on checkpoint → steered
    assert "把重点放在风险上" not in _user_prompt("付款")  # u2 unrelated → not polluted


async def test_checkpoint_timeout_continues():
    # A soft checkpoint that times out proceeds (never silently halts): no resolve,
    # tiny timeout → both steps run.
    registry = InteractionRegistry()
    sink = EventSink()
    tool = _tool_ckpt(_Provider(["S1OUT", "S2OUT"]), sink, registry, "conv1", timeout=0.05)
    result = await tool.execute({"tasks": _CKPT_DAG}, _ctx())
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
    types = [e.type async for e in sink]
    # The pause still surfaced (and resolved by timeout), even though it proceeded.
    assert EventType.PLAN_REVIEW_REQUIRED in types
    assert EventType.PLAN_REVIEW_RESOLVED in types


async def test_checkpoint_inert_when_disabled():
    # The default delegate tool (no bridge / gate off) ignores checkpoint_after:
    # the DAG runs straight through, no plan_review is ever emitted.
    sink = EventSink()
    tool = _tool(_Provider(["S1OUT", "S2OUT"]), sink=sink)
    result = await tool.execute({"tasks": _CKPT_DAG}, _ctx())
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.PLAN_REVIEW_REQUIRED not in types


def test_plan_review_resolve_body_discriminates():
    # The resolve endpoint discriminates on ``kind`` (Body(discriminator="kind")):
    # a plan_review body must route to ResolvePlanReviewInteraction and carry the
    # continue/stop decision the WaveScheduler hook consumes (as a CheckpointResponse).
    from typing import Annotated

    from pydantic import Field, TypeAdapter

    from agentcore.api.schemas import (
        ResolveInteractionRequest,
        ResolvePlanReviewInteraction,
    )

    adapter = TypeAdapter(
        Annotated[ResolveInteractionRequest, Field(discriminator="kind")]
    )
    body = adapter.validate_python(
        {"kind": "plan_review", "decision": "stop", "note": "halt"}
    )
    assert isinstance(body, ResolvePlanReviewInteraction)
    assert body.decision is CheckpointDecision.STOP
    assert body.note == "halt"


# --- 结构化挂起 2b: durable frame capture + resume_plan (turn 级落盘 + /resume) -----


def _tool_durable(
    provider: _Provider,
    sink: EventSink,
    registry: InteractionRegistry,
    saver,
    deleter,
) -> DelegateTool:
    """A top-level (depth 0) delegate wired for DURABLE checkpoints: message_id +
    persist/drop closures, so a plan_review pause is captured to a frame."""
    return DelegateTool(
        llm=provider,
        sink=sink,
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
        conversation_id="conv1",
        registry=registry,
        checkpoint_timeout_seconds=5.0,
        checkpoint_enabled=True,
        message_id="m1",
        suspension_saver=saver,
        suspension_deleter=deleter,
        captain_run_id="CEO",
    )


async def test_durable_pause_persists_frame_then_drops_on_live_resolve():
    # A top-level pause persists a TurnSuspension BEFORE the wait (so a disconnect
    # leaves a resumable frame) and DROPS it after a live in-process resolve (the
    # live turn settled, the backstop is stale). The frame captures the plan (minted
    # ids), the reviewed/pending steps, and the CEO transcript's delegate tool-call.
    from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction
    from agentcore.runtime.suspension import TurnSuspension, captain_transcript

    registry = InteractionRegistry()
    sink = EventSink()
    saved: list[TurnSuspension] = []
    dropped: list[str] = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        dropped.append(mid)

    tool = _tool_durable(_Provider(["S1OUT", "S2OUT"]), sink, registry, _save, _drop)
    # Publish a CEO transcript ending with the delegate tool-call (as the captain
    # executor would), so the hook can capture it off the contextvar.
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
        exec_task = asyncio.create_task(tool.execute({"tasks": _CKPT_DAG}, _ctx()))
        await _resolve_when_pending(registry, "conv1", CheckpointDecision.CONTINUE)
        result = await exec_task
    finally:
        captain_transcript.reset(token)

    assert len(saved) == 1
    frame = saved[0]
    assert frame.message_id == "m1"
    assert frame.conversation_id == "conv1"
    assert frame.captain_run_id == "CEO"
    assert frame.tool_call_id == "call_del"
    # the plan (with its minted ids) + completed seed line up for a WaveScheduler resume
    assert len(frame.plan.nodes) == 2
    assert frame.completed  # s1 finished before the pause
    assert any(s["role"] == "研究员" for s in frame.steps)
    assert any(p["role"] == "写手" for p in frame.pending)
    # the pause's plan_review_required is captured on the suspension's journal — it is
    # saved to turn_journal (§18.3, not the frame JSON) for the resume to replay.
    assert any(e["type"] == "plan_review_required" for e in frame.journal)
    # live resolve dropped the now-stale backstop
    assert dropped == ["m1"]
    assert "S1OUT" in result.output and "S2OUT" in result.output


async def test_durable_capture_skipped_without_transcript():
    # No captain transcript published (e.g. an unusual call path) ⇒ the hook can't
    # build a faithful frame, so it skips persistence (the live resolve still works).
    registry = InteractionRegistry()
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        pass

    tool = _tool_durable(_Provider(["S1OUT", "S2OUT"]), EventSink(), registry, _save, _drop)
    exec_task = asyncio.create_task(tool.execute({"tasks": _CKPT_DAG}, _ctx()))
    await _resolve_when_pending(registry, "conv1", CheckpointDecision.CONTINUE)
    await exec_task
    assert saved == []  # nothing captured without a transcript


async def test_durable_resume_drives_tail_from_journal_not_frame():
    # 执行级事件溯源 Phase 2 e2e (frame.plan/.completed 退场): the FULL pause → durable-resume
    # chain proves the resumed turn rebuilds BOTH the DAG and the finished-worker seed from
    # the TURN JOURNAL — never the frame, which no longer serializes them. Drive a real
    # captain delegate to a checkpoint pause under a bound fact log (so the snapshot carries
    # the plan_snapshot + s1 run-final facts), round-trip the frame through to_json (dropping
    # plan/completed/transcript), re-attach the journaled entries as ``claim_paused_turn``
    # would, then settle a CONTINUE — s2 must run, seeded by s1, off the journal projection.
    from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction
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

    # --- Phase A: drive a REAL captain delegate to its checkpoint pause -----------------
    pause_tool = _tool_durable(
        _Provider(["S1OUT", "S2OUT"]), EventSink(), registry, _save, _drop
    )
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
        exec_task = asyncio.create_task(pause_tool.execute({"tasks": _CKPT_DAG}, _ctx()))
        await _resolve_when_pending(registry, "conv1", CheckpointDecision.CONTINUE)
        await exec_task
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(log_token)

    assert saved, "the durable checkpoint must have captured a frame"
    captured = saved[0]

    # --- Phase B: simulate claim_paused_turn — the frame round-trips through to_json -----
    # (plan / completed / transcript DROPPED), and turn_journal re-hydrates journal_entries.
    restored = suspension_from_json(captured.to_json())
    assert isinstance(restored, PlanReviewSuspension)
    assert restored.plan.nodes == []  # the DAG is NOT in the frame anymore
    assert restored.completed == {}  # nor the finished-worker seed
    restored.journal_entries = list(captured.journal_entries)

    # The journal ALONE rebuilds the 2-node DAG (with minted ids) + the s1 seed.
    projected_plan = plan_from_journal(restored.journal_entries)
    assert projected_plan is not None and len(projected_plan.nodes) == 2
    assert len(completed_from_journal(restored.journal_entries)) == 1

    # --- Phase C: durably resume — settle a CONTINUE with a FRESH delegate --------------
    resume_sink = EventSink()
    resume_sink.seed_journal(
        [{"type": EventType.PLAN_REVIEW_REQUIRED.value, "payload": {}, "timestamp": "t"}]
    )
    resume_provider = _Provider(["S2OUT"])
    resume_tool = _tool(resume_provider, resume_sink)
    settled = await _settle_resumed_suspension(
        restored,
        decision=CheckpointDecision.CONTINUE,
        note="",
        selected=[],
        sink=resume_sink,
        delegate_tool=resume_tool,
        execution_id="e_resume",
    )
    assert "S1OUT" in settled.output  # the seeded product (from the journal) is shown
    assert "S2OUT" in settled.output  # the tail ran on resume
    assert resume_provider.calls == 1  # ONLY s2 ran — s1 was re-seeded from facts, not re-run


def _resume_plan(prefix: str = "del_resume"):
    """Build a 2-step checkpoint DAG plan the way ``execute`` does, for resume tests."""
    from agentcore.runtime.runs import build_run_plan

    plan, errors = build_run_plan(
        _CKPT_DAG,
        valid_tools=set(),
        id_prefix=prefix,
        parent_run_id="CEO",
        depth=1,
    )
    assert not errors
    return plan


async def test_resume_plan_continue_runs_only_the_tail():
    # CONTINUE: s1 is seeded (already finished pre-pause) so only s2 runs; both the
    # seeded product and the freshly-run tail come back to the CEO.
    plan = _resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = _Provider(["S2OUT"])
    tool = _tool(provider)
    result = await tool.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.CONTINUE,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in result.output  # seeded product still shown
    assert "S2OUT" in result.output  # tail ran
    assert provider.calls == 1  # ONLY s2 ran (s1 was seeded, not re-run)


async def test_resume_plan_stop_skips_the_tail():
    # STOP: don't run the tail — s2 is materialised SKIPPED, s1's product is kept, and
    # the LLM is never called (no tail). The CEO writes an overview of the partial work.
    plan = _resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = _Provider(["SHOULD_NOT_RUN"])
    tool = _tool(provider)
    result = await tool.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.STOP,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in result.output
    assert "SHOULD_NOT_RUN" not in result.output
    assert provider.calls == 0  # the tail never ran
    assert "写手" in result.output  # s2 still shown (as un-run) in the summary


async def test_resume_plan_adjust_steers_the_tail():
    # ADJUST: inject the note as a steer onto the reviewed checkpoint's not-yet-run
    # dependents, then continue — s2 runs AND its prompt carries the steer.
    plan = _resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = _Provider(["S2OUT"])
    tool = _tool(provider)
    result = await tool.resume_plan(
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


def test_format_for_ceo_surfaces_file_manifest_and_skip_filelist_hint():
    # A worker that wrote files exposes them as a 文件产出 manifest in the CEO-facing
    # aggregate, and the footer tells the CEO not to re-list the workspace to verify —
    # 收敛阶段省掉冗余 file_list 轮 (改法A).
    tool = _tool(_Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="建仪表盘", role="前端工程师")])
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED,
            content="已完成仪表盘",
            files_touched=["dashboard.html", "assets/styles.css"],
        )
    }
    out = tool._format_for_ceo(plan, results)
    assert "文件产出（已写入工作区）" in out
    assert "`dashboard.html`" in out
    assert "`assets/styles.css`" in out
    assert "无需再用 file_list" in out


def test_format_for_ceo_omits_manifest_when_worker_touched_no_files():
    tool = _tool(_Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段研究综述")}
    out = tool._format_for_ceo(plan, results)
    # 改法A 的「无噪音」契约：纯文本 worker 不渲染逐项文件清单（避免噪音）。守卫只在
    # footer 规则里，不给每个无文件的 worker 盲标，免得误伤合法的调研/分析/辩论 worker。
    # （footer 规则文本里会提到「文件产出」一词，故只断言逐项清单行 `> 文件产出` 不出现。）
    assert "> 文件产出" not in out


def test_format_for_ceo_footer_guards_against_claiming_unwritten_files():
    # 防幻觉守卫: even when NO worker wrote files, the footer must instruct the CEO
    # that「文件产出」is the sole ground truth — a worker that CLAIMS files but has
    # no manifest line did NOT actually write them, so the CEO must judge that file
    # delivery 未达成 and never report it as done. Text-only workers stay exempt.
    tool = _tool(_Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="建文件", role="工程师")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="我已创建 app.py 并写入代码")}
    out = tool._format_for_ceo(plan, results)
    assert "防幻觉" in out
    assert "未真正写入" in out
    assert "未达成" in out
    assert "属正常" in out  # text-only workers are explicitly exempted


def test_format_for_ceo_surfaces_escalations_blockers_first():
    # Worker escalations are surfaced PROMINENTLY (a top section) with the question +
    # its暂用假设, blockers marked and sorted first, plus the resolve guidance
    # (ask_user / revise). Each escalating worker's own block also carries a marker.
    tool = _tool(_Provider([]))
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="查行情", role="调研"),
            RunSpec(run_id="w2", task="建后端", role="后端"),
        ]
    )
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED,
            content="软的备注",
            escalations=[{"question": "目标受众是谁?", "assumption": "暂按大众", "blocking": False}],
        ),
        "w2": RunState(
            phase=RunPhase.COMPLETED,
            content="后端骨架",
            escalations=[{"question": "用 Postgres 还是 MySQL?", "assumption": "暂用 PG", "blocking": True}],
        ),
    }
    out = tool._format_for_ceo(plan, results)
    assert "队员升级了待决问题" in out
    assert "用 Postgres 还是 MySQL?" in out and "目标受众是谁?" in out
    assert "其暂用假设：暂用 PG" in out
    # The blocking item is marked and ordered before the non-blocking one.
    assert "【关键阻塞】" in out
    assert out.index("Postgres") < out.index("目标受众")
    # The CEO is told HOW to resolve, via its own levers.
    assert "ask_user" in out and "revise" in out
    # Each escalating worker's own block flags it too.
    assert "已升级 1 项待决问题" in out


def test_format_for_ceo_no_escalation_section_when_none():
    tool = _tool(_Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段综述")}
    out = tool._format_for_ceo(plan, results)
    assert "队员升级了待决问题" not in out


# --- CEO 综述输入瘦身 (fidelity discipline on the CEO synthesis input) ---


def test_format_for_ceo_digests_file_producer_not_full_content():
    # A worker that wrote files has its prose DIGESTED in the CEO aggregate (the full
    # product is redundant — on disk + shown full in the UI); the 文件产出 manifest (the
    # ground truth) still rides so the CEO can file_read for detail.
    tool = _tool(_Provider([]))
    long_body = "开头摘要。" + ("废" * 5_000) + "结尾独特标记XYZ"
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="写报告", role="撰稿")])
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED, content=long_body, files_touched=["report.md"]
        )
    }
    out = tool._format_for_ceo(plan, results)
    assert "`report.md`" in out  # manifest (ground truth) kept
    assert "结尾独特标记XYZ" not in out  # full body NOT dumped — digested
    assert len(out) < len(long_body)  # the aggregate is far smaller than the raw product


def test_format_for_ceo_bounds_wide_fanout_keeping_all_workers_and_closing():
    # The correctness fix: a wide fan-out of long prose products used to be blunt
    # head-chopped by the single output_limit — silently dropping late workers AND the
    # closing instructions. Fidelity budgeting keeps EVERY worker represented and the
    # footer intact, with the aggregate bounded well under the output_limit net.
    from agentcore.tools.builtin.delegate import _DELEGATE_OUTPUT_LIMIT

    tool = _tool(_Provider([]))
    nodes = [RunSpec(run_id=f"w{i}", task="分析", role=f"分析{i}") for i in range(8)]
    plan = RunPlan(nodes=nodes)
    results = {
        f"w{i}": RunState(
            phase=RunPhase.COMPLETED, content=f"头{i}" + ("数" * 8_000) + f"尾{i}"
        )
        for i in range(8)
    }
    out = tool._format_for_ceo(plan, results)
    for i in range(8):  # every worker still represented (none silently dropped)
        assert f"run_id: `w{i}`" in out
    assert "防幻觉" in out and "简短概览" in out  # closing instructions survive
    assert len(out) < _DELEGATE_OUTPUT_LIMIT  # blunt net wouldn't even trigger
    assert "中间省略" in out  # content was actually head+tail trimmed


def test_format_for_ceo_short_prose_passes_through_whole():
    # A short prose worker (no files) is well within budget → reproduced verbatim, no
    # digesting / trimming applied (fidelity only bites when a product is large).
    tool = _tool(_Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段不长的研究综述，结论是甲。")}
    out = tool._format_for_ceo(plan, results)
    assert "一段不长的研究综述，结论是甲。" in out  # full content kept
    assert "中间省略" not in out  # nothing trimmed


def test_format_for_ceo_emits_uncapped_synthesis_metric():
    # 调度埋点量化（收尾侧）: a wide fan-out of long prose emits a delegate.synthesis line
    # showing 瘦身 worked — the blunt output_limit net does NOT fire (capped=False) and
    # the aggregate is genuinely compressed (ratio < 1).
    from structlog.testing import capture_logs

    tool = _tool(_Provider([]))
    nodes = [RunSpec(run_id=f"w{i}", task="分析", role=f"分析{i}") for i in range(8)]
    plan = RunPlan(nodes=nodes)
    results = {
        f"w{i}": RunState(phase=RunPhase.COMPLETED, content=f"头{i}" + ("数" * 8_000))
        for i in range(8)
    }
    with capture_logs() as logs:
        tool._format_for_ceo(plan, results)
    metric = next(e for e in logs if e["event"] == "delegate.synthesis")
    assert metric["capped"] is False  # 瘦身 keeps the aggregate under the output_limit net
    assert metric["workers"] == 8 and metric["prose"] == 8
    assert metric["ratio"] < 1.0  # compression actually happened
