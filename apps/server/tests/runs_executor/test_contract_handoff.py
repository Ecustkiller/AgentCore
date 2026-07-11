"""Contract gate with file_write + handoff (empty streamed content)."""

import json

from agentcore.llm.provider.protocol import LLMChunk, ToolCallDelta
from agentcore.runtime.events import EventSink
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.contract import debrief_meets_minimum
from agentcore.runtime.runs.executor import build_agent_executor
from agentcore.runtime.runs.types import RunPhase
from agentcore.runtime.runs.wave import WaveScheduler
from agentcore.tools.builtin.handoff import HandoffTool
from agentcore.tools.registry import ToolRegistry
from tests.runs_executor.conftest import _ContentProvider, _ctx, _FileWriteTool, _ScriptedRounds


async def test_file_write_handoff_empty_content_passes_without_retry():
    """Worker finishes with file_write + handoff and no streamed prose — must not 产出为空 retry."""
    plan, _ = build_run_plan([{"role": "W", "task": "write file"}], id_prefix="t")
    reg = ToolRegistry()
    reg.register(_FileWriteTool())
    reg.register(HandoffTool())
    rounds = [
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="w1",
                        function_name="file_write",
                        arguments_delta='{"path": "p.txt", "content": "hi"}',
                    )
                ]
            )
        ],
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="h1",
                        function_name="handoff",
                        arguments_delta='{"summary": "done writing"}',
                    )
                ]
            )
        ],
    ]
    provider = _ScriptedRounds(rounds)
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="req",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    assert provider.calls == 2  # no contract retry
    assert state.files_touched == ["p.txt"]
    assert state.debrief == {"summary": "done writing"}


class _HandoffOnFeedbackProvider:
    """Content first; on handoff-gate feedback, emit a qualifying handoff call."""

    def __init__(self, contents: list[str]) -> None:
        self._contents = contents
        self._content_i = 0
        self.calls = 0
        self.requests: list[list[tuple[str, str]]] = []

    async def stream(self, request):  # noqa: ANN001
        self.calls += 1
        self.requests.append([(m.role, m.content or "") for m in request.messages])
        joined = "\n".join(m.content or "" for m in request.messages if m.role == "user")
        if "handoff" in joined.lower() or "交接" in joined:
            args = json.dumps(
                {
                    "summary": "这是一段足够长的合格交接结论，涵盖方案要点与下游接手注意。",
                    "key_points": ["路径 a.py", "约定字段 id"],
                },
                ensure_ascii=False,
            )
            yield LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id=f"h{self.calls}",
                        function_name="handoff",
                        arguments_delta=args,
                    )
                ]
            )
            return
        text = (
            self._contents[self._content_i]
            if self._content_i < len(self._contents)
            else "done"
        )
        self._content_i += 1
        yield LLMChunk(delta_content=text)


async def test_upstream_missing_handoff_forced_then_accepted_on_rework():
    """With handoff offered: missing brief → correction shot → qualifying handoff."""
    plan, _ = build_run_plan(
        [
            {"id": "arch", "role": "架构师", "task": "出方案"},
            {"id": "impl", "role": "实现", "task": "落地", "depends_on": ["arch"]},
        ],
        id_prefix="t",
    )
    reg = ToolRegistry()
    reg.register(HandoffTool())
    provider = _HandoffOnFeedbackProvider(["架构草案初版", "实现完成正文"])
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="req",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    arch = res["t_arch"]
    impl = res["t_impl"]
    assert arch.phase is RunPhase.COMPLETED
    assert arch.debrief is not None
    assert not arch.debrief.get("degraded")
    assert debrief_meets_minimum(arch.debrief)
    assert any(
        "交接" in "\n".join(c for _, c in req if c)
        or "handoff" in "\n".join(c for _, c in req if c).lower()
        for req in provider.requests
    )
    assert impl.phase is RunPhase.COMPLETED
    assert impl.debrief is None


async def test_upstream_without_handoff_tool_synthesizes_degraded_without_rework():
    """Empty registry cannot call handoff — skip correction shot, synth degraded."""
    plan, _ = build_run_plan(
        [
            {"id": "arch", "role": "架构师", "task": "出方案"},
            {"id": "impl", "role": "实现", "task": "落地", "depends_on": ["arch"]},
        ],
        id_prefix="t",
    )
    provider = _ContentProvider(["架构草案初版", "实现完成正文"])
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="req",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    arch = res["t_arch"]
    assert arch.phase is RunPhase.COMPLETED
    assert arch.content == "架构草案初版"
    assert arch.debrief is not None
    assert arch.debrief.get("degraded") is True
    assert provider.calls == 2  # no wasted rework round
    assert res["t_impl"].debrief is None


async def test_leaf_without_dependents_does_not_force_handoff():
    plan, _ = build_run_plan([{"role": "分析", "task": "只读调研"}], id_prefix="t")
    provider = _ContentProvider(["调研结论一段"])
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="req",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    assert state.debrief is None
    assert provider.calls == 1


async def test_artifacts_missing_reworks_then_soft_accepts_with_warning():
    plan, _ = build_run_plan(
        [
            {
                "role": "集成",
                "task": "收口",
                "deliverable": {"artifacts": ["README.md", "examples/demo.py"]},
            }
        ],
        id_prefix="t",
    )
    provider = _ContentProvider(["只写了正文一", "只写了正文二仍缺文件"])
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=ToolRegistry(),
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="req",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    assert provider.calls == 2
    assert any("README.md" in w for w in state.warnings)


async def test_artifacts_hit_when_file_write_covers_declared_path():
    plan, _ = build_run_plan(
        [
            {
                "role": "集成",
                "task": "收口",
                "deliverable": {"artifacts": ["README.md"]},
            }
        ],
        id_prefix="t",
    )
    reg = ToolRegistry()
    reg.register(_FileWriteTool())
    rounds = [
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="w1",
                        function_name="file_write",
                        arguments_delta='{"path": "README.md", "content": "# hi"}',
                    )
                ]
            )
        ],
        [LLMChunk(delta_content="已写入 README")],
    ]
    provider = _ScriptedRounds(rounds)
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="req",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    state = res["t_1"]
    assert state.phase is RunPhase.COMPLETED
    assert state.warnings == []
    assert state.files_touched == ["README.md"]
