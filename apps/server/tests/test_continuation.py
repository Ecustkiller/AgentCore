"""同人续派（delegate.continue_from_run_id）— 成功路径、校验失败分支、唤回闸、同批组合。"""

from pathlib import Path

from agentcore.llm.provider.protocol import LLMChunk, TokenUsage
from agentcore.runtime.delegate.continuation import (
    ContinuationRejectedError,
    resolve_session,
)
from agentcore.runtime.delegate.drive import drive
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.runs import (
    RunSession,
    WaveScheduler,
    build_agent_executor,
    build_run_plan,
)
from agentcore.runtime.runs.constants import DEFAULT_RECALL_LIMIT
from agentcore.runtime.sessions import SessionStore
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _Provider:
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
        run_id="CEO",
        agent_id="CEO",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _tool(store: SessionStore, provider: _Provider, sink: EventSink | None = None) -> DelegateTool:
    return DelegateTool(
        llm=provider,
        sink=sink or EventSink(),
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
        captain_run_id="CEO",
        session_store=store,
    )


async def _seed(store: SessionStore, provider: _Provider, *, run_id: str = "t_1") -> RunSession:
    plan, _ = build_run_plan(
        [{"role": "研究员", "task": "做A"}], id_prefix="t", parent_run_id="CEO"
    )
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
        run_id=run_id,
        spec=plan.by_id(run_id),
        transcript=state.transcript,
        content=state.content,
    )
    store.put(session)
    return session


async def test_continue_from_hit_returns_product_and_bumps_recall():
    store = SessionStore()
    usage = TokenUsage(input_tokens=10, output_tokens=5)
    provider = _Provider(["第一版", "续写版"], usage=usage)
    await _seed(store, provider)
    sink = EventSink()
    tool = _tool(store, provider, sink)

    result = await tool.execute(
        {
            "tasks": [
                {
                    "role": "研究员",
                    "task": "把语气改正式并补风险",
                    "continue_from_run_id": "t_1",
                }
            ],
            "coordinate": False,
            "complexity_hint": "light",
        },
        _ctx(),
    )

    assert result.success is True
    assert "续写版" in result.output
    assert store.get("t_1").recall_count == 1
    assert store.get("t_1").content == "续写版"
    assert tool.continuation_count == 1
    sink.close()
    events = [e async for e in sink]
    started = [
        e
        for e in events
        if e.type is EventType.RUN_STARTED and e.payload.get("continues_run_id")
    ]
    assert started
    assert started[0].payload["continues_run_id"] == "t_1"
    assert started[0].payload["parent_run_id"] == "CEO"
    assert "revision" not in started[0].payload


async def test_continue_from_miss_rejects_with_cold_hint():
    store = SessionStore()
    provider = _Provider(["x"])
    tool = _tool(store, provider)
    result = await tool.execute(
        {
            "tasks": [
                {
                    "role": "研究员",
                    "task": "接着干",
                    "continue_from_run_id": "ghost",
                }
            ],
            "coordinate": False,
            "complexity_hint": "light",
        },
        _ctx(),
    )
    assert result.success is True
    assert "冷委派" in result.output or "找不到" in result.output
    assert tool.continuation_count == 0


async def test_continue_from_self_ref_rejected():
    store = SessionStore()
    provider = _Provider(["第一版"])
    await _seed(store, provider)
    tool = _tool(store, provider)
    try:
        await resolve_session(tool, "t_1", own_run_id="t_1")
        raise AssertionError("expected ContinuationRejectedError")
    except ContinuationRejectedError as exc:
        assert "自指" in exc.message


async def test_continue_from_capped_rejects():
    store = SessionStore()
    provider = _Provider(["第一版", "续"])
    session = await _seed(store, provider)
    session.recall_count = DEFAULT_RECALL_LIMIT
    store.put(session)
    tool = _tool(store, provider)
    result = await tool.execute(
        {
            "tasks": [
                {
                    "role": "研究员",
                    "task": "再改",
                    "continue_from_run_id": "t_1",
                }
            ],
            "coordinate": False,
            "complexity_hint": "light",
        },
        _ctx(),
    )
    assert "上限" in result.output
    assert tool.continuation_count == 0


async def test_same_batch_depends_on_plus_continue_from():
    """单个 run 完成即登记 → 同批 depends_on X + continue_from X 成立。"""
    store = SessionStore()
    provider = _Provider(["调研稿", "续写实现"])
    tool = _tool(store, provider, EventSink())
    plan, errs = build_run_plan(
        [
            {"id": "a", "role": "研究员", "task": "先调研"},
            {
                "id": "b",
                "role": "研究员",
                "task": "据调研接着写",
                "depends_on": ["a"],
                "continue_from_run_id": "p_a",
            },
        ],
        id_prefix="p",
        parent_run_id="CEO",
    )
    assert not errs
    assert plan.by_id("p_b").continue_from_run_id == "p_a"

    out = await drive(
        tool,
        plan,
        execution_id="e",
        finalize=False,
        call_idx=1,
        seed_notes=None,
        complexity_hint="standard",
        completion_criteria=None,
        session=None,
        seed_completed=None,
        coordinate=False,
    )
    assert out.success is True
    assert "续写实现" in out.output
    assert store.get("p_a") is not None
    assert store.get("p_a").recall_count == 1
    assert tool.continuation_count == 1
