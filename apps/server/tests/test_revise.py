"""ReviseTool — 定向唤回（乙 热修）end to end (P1).

Drives the tool with a scripted fake provider (no network): a hit recalls the
saved author and returns the revised product non-terminally; a miss / over-cap
call refuses and steers the CEO back to ``delegate`` (回落甲). Also pins the
roster commit (recall_count bump, transcript extension) and member accounting.
"""

from pathlib import Path

from agentcore.llm.protocol import LLMChunk, LLMMessage, TokenUsage
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs import RunSession, RunSpec, build_agent_executor, build_run_plan
from agentcore.runtime.runs.constants import DEFAULT_RECALL_LIMIT
from agentcore.runtime.sessions import SessionStore
from agentcore.tools.builtin.revise import ReviseTool
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


async def _seed_session(store: SessionStore, provider: _Provider, *, run_id="t_1") -> RunSession:
    """Run a worker through the executor and register it in the roster (as delegate
    does), so revise has a real captured transcript to continue."""
    from agentcore.runtime.runs import WaveScheduler

    plan, _ = build_run_plan([{"role": "研究员", "task": "做A"}], id_prefix="t")
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res[run_id]
    session = RunSession(
        run_id=run_id, spec=plan.by_id(run_id), transcript=state.transcript, content=state.content
    )
    store.put(session)
    return session


def _tool(
    store: SessionStore,
    provider: _Provider,
    sink: EventSink | None = None,
    *,
    saver=None,
    loader=None,
) -> ReviseTool:
    return ReviseTool(
        llm=provider,
        sink=sink or EventSink(),
        session_store=store,
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
        captain_run_id="CEO",
        session_saver=saver,
        session_loader=loader,
    )


async def test_revise_hit_returns_revised_product_non_terminal():
    store = SessionStore()
    usage = TokenUsage(input_tokens=10, output_tokens=5, cache_hit_tokens=6, cache_miss_tokens=4)
    provider = _Provider(["第一版", "修订版"], usage=usage)
    await _seed_session(store, provider)
    tool = _tool(store, provider)

    result = await tool.execute({"target_run_id": "t_1", "feedback": "改正式点"}, _ctx())

    assert result.success is True
    assert result.is_terminal is False  # non-terminal, like delegate
    assert "修订版" in result.output
    # roster committed: the改次闸 counts up and the latest draft is preserved for a
    # FURTHER revise of the same product.
    updated = store.get("t_1")
    assert updated.recall_count == 1
    assert updated.content == "修订版"
    assert updated.transcript[-1].content == "修订版"


async def test_revise_accounts_one_member_row_parented_to_original():
    store = SessionStore()
    usage = TokenUsage(input_tokens=10, output_tokens=5, cache_hit_tokens=6, cache_miss_tokens=4)
    provider = _Provider(["第一版", "修订版"], usage=usage)
    await _seed_session(store, provider)
    tool = _tool(store, provider)

    await tool.execute({"target_run_id": "t_1", "feedback": "改"}, _ctx())

    # one ledger row for the revision, its own run_id, parented to the original run
    assert len(tool.run_ledger) == 1
    row = tool.run_ledger[0]
    assert row.run_id == "t_1_rev1"
    assert row.parent_run_id == "t_1"
    # the continuation's usage folds into the tool total (the pipeline reads this)
    assert tool.usage["input"] == 10
    assert tool.usage["output"] == 5


async def test_revise_emits_revision_node_on_graph():
    store = SessionStore()
    provider = _Provider(["第一版", "修订版"])
    await _seed_session(store, provider)
    sink = EventSink()
    tool = _tool(store, provider, sink=sink)
    await tool.execute({"target_run_id": "t_1", "feedback": "改"}, _ctx())
    sink.close()
    events = [e async for e in sink]
    started = [e for e in events if e.type == EventType.RUN_STARTED]
    assert any(
        e.payload["run_id"] == "t_1_rev1" and e.payload["parent_run_id"] == "t_1"
        for e in started
    )


async def test_revise_miss_falls_back_to_delegate():
    # 跨回合 / 未知 run → miss 分支 = 甲：refuse and steer back to delegate.
    store = SessionStore()
    tool = _tool(store, _Provider([]))
    result = await tool.execute({"target_run_id": "ghost", "feedback": "改"}, _ctx())
    assert result.success is False
    assert "delegate" in result.output


async def test_revise_over_cap_falls_back_to_delegate():
    # 改次闸：already at the recall limit → refuse, steer to delegate (回落甲).
    store = SessionStore()
    spec = RunSpec(run_id="t_1", agent_id="t_1", role="A", task="t")
    store.put(
        RunSession(
            run_id="t_1",
            spec=spec,
            transcript=[
                LLMMessage(role="system", content="s"),
                LLMMessage(role="user", content="u"),
                LLMMessage(role="assistant", content="v"),
            ],
            content="v",
            recall_count=DEFAULT_RECALL_LIMIT,
        )
    )
    tool = _tool(store, _Provider(["x"]))
    result = await tool.execute({"target_run_id": "t_1", "feedback": "改"}, _ctx())
    assert result.success is False
    assert "上限" in result.output
    assert "delegate" in result.output


async def test_revise_requires_target_and_feedback():
    tool = _tool(SessionStore(), _Provider([]))
    assert (await tool.execute({"feedback": "x"}, _ctx())).success is False
    assert (await tool.execute({"target_run_id": "t_1"}, _ctx())).success is False
    assert (await tool.execute({"target_run_id": "  ", "feedback": "x"}, _ctx())).success is False


async def test_revise_twice_continues_from_latest_and_bumps_count():
    store = SessionStore()
    provider = _Provider(["第一版", "修订1", "修订2"])
    await _seed_session(store, provider)
    tool = _tool(store, provider)
    await tool.execute({"target_run_id": "t_1", "feedback": "改一次"}, _ctx())
    r2 = await tool.execute({"target_run_id": "t_1", "feedback": "再改一次"}, _ctx())
    assert r2.success is True
    assert "修订2" in r2.output
    assert store.get("t_1").recall_count == 2
    # second revision's run id reflects the bumped count
    assert tool.run_ledger[-1].run_id == "t_1_rev2"


# --- P3 跨进程落盘: durable roster load-on-miss + write-through ---


async def test_revise_loads_from_durable_roster_on_memory_miss():
    # Seed + capture a session, then hand the tool an EMPTY in-memory store plus a
    # loader returning the captured one — i.e. a restart / eviction dropped the live
    # roster but the DB still has it. revise must rehydrate and succeed (not 回落甲).
    seed_store = SessionStore()
    provider = _Provider(["第一版", "修订版"])
    seeded = await _seed_session(seed_store, provider)
    loaded: list[str] = []

    async def loader(run_id: str):
        loaded.append(run_id)
        return seeded if run_id == seeded.run_id else None

    mem = SessionStore()  # empty → in-memory miss
    tool = _tool(mem, provider, loader=loader)

    result = await tool.execute({"target_run_id": "t_1", "feedback": "改"}, _ctx())

    assert result.success is True
    assert loaded == ["t_1"]  # the loader was consulted on the miss
    assert "修订版" in result.output
    # re-warmed into the in-memory store so a further same-process revise hits memory
    assert mem.get("t_1") is not None


async def test_revise_writes_through_saver_on_commit():
    store = SessionStore()
    provider = _Provider(["第一版", "修订版"])
    await _seed_session(store, provider)
    saved: list[tuple[str, int, str]] = []

    async def saver(session: RunSession) -> None:
        saved.append((session.run_id, session.recall_count, session.content))

    tool = _tool(store, provider, saver=saver)
    await tool.execute({"target_run_id": "t_1", "feedback": "改"}, _ctx())

    # the revised session is persisted with the bumped count + latest draft, so the
    # 改次闸 and continuation survive a restart.
    assert saved == [("t_1", 1, "修订版")]


async def test_revise_loader_miss_falls_back_to_delegate():
    # Durable roster also empty (loader returns None) → genuinely gone → 回落甲.
    async def loader(run_id: str):
        return None

    tool = _tool(SessionStore(), _Provider([]), loader=loader)
    result = await tool.execute({"target_run_id": "ghost", "feedback": "改"}, _ctx())
    assert result.success is False
    assert "delegate" in result.output
