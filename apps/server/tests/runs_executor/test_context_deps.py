from agentcore.llm.protocol import LLMChunk, ToolCallDelta
from agentcore.runtime.events import EventSink
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.executor import _dep_context_blocks, build_agent_executor
from agentcore.runtime.runs.types import RunPhase, RunSpec
from agentcore.runtime.runs.wave import WaveScheduler
from agentcore.tools.registry import ToolRegistry

from tests.runs_executor.conftest import (
    _FileWriteTool,
    _ScriptedRounds,
    _ctx,
    _plan,
    _state,
)


def test_dep_block_file_writer_becomes_pointer():
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="构建器", task="生成数据"))
    completed = {
        "u": _state("已生成数据集，详见文件。", files=["data/out.csv", "data/schema.json"])
    }
    blocks = _dep_context_blocks(plan, ["u"], completed)
    assert len(blocks) == 1
    block = blocks[0]
    assert block.channel == "dependency"
    assert block.source_role == "构建器"
    assert block.source_run_id == "u"
    assert block.fidelity == "pointer"  # file-writer → pointer fidelity
    body = block.body
    assert "已生成数据集" in body  # the worker's prose handoff digest is kept
    assert "data/out.csv" in body and "data/schema.json" in body  # the pointer
    assert "file_read" in body  # told how to pull the full content
    assert block.files == ["data/out.csv", "data/schema.json"]  # artifact paths carried


def test_dep_pointer_digests_prose_instead_of_shipping_whole():
    # A file-writer with a huge prose body is DIGESTED (not budget-passed whole):
    # the artifact is on disk, the prompt only needs orientation + the path.
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="写手", task="写报告"))
    huge = "开头摘要" + ("文" * 5_000)
    blocks = _dep_context_blocks(plan, ["u"], {"u": _state(huge, files=["report.md"])})
    body = blocks[0].body
    assert "开头摘要" in body  # head digest present
    assert huge not in body  # but NOT the full 5000-char product
    assert "report.md" in body


def test_dep_pointer_caps_file_list_with_elision():
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="生成器", task="批量生成"))
    files = [f"f{i}.txt" for i in range(30)]
    body = _dep_context_blocks(plan, ["u"], {"u": _state("done", files=files)})[0].body
    assert "f0.txt" in body  # the first ones are listed
    assert "f25.txt" not in body  # beyond DEP_POINTER_MAX_FILES (20) is elided
    assert "共 30 个文件" in body  # and the full count is disclosed


def test_dep_block_prose_dep_unchanged_full_text():
    # No files → the existing full-text path: a short prose dep is passed through whole.
    plan = _plan(RunSpec(run_id="u", agent_id="u", role="研究员", task="调研"))
    block = _dep_context_blocks(plan, ["u"], {"u": _state("纯文字结论无文件")})[0]
    assert block.body == "纯文字结论无文件"
    assert block.fidelity == "pass_through"  # no files → prose pass_through
    assert block.truncated is False  # short prose fits the budget whole


async def test_dag_file_writing_upstream_passes_pointer_downstream():
    # End-to-end: the upstream WRITES a file; the downstream's opening prompt carries
    # a pointer (path + file_read hint), proving files_touched flows RunState→prompt.
    tasks = [
        {"id": "s1", "role": "构建器", "task": "生成数据文件"},
        {"id": "s2", "role": "分析师", "task": "分析数据", "depends_on": ["s1"]},
    ]
    plan, _ = build_run_plan(tasks, id_prefix="t")
    reg = ToolRegistry()
    reg.register(_FileWriteTool())
    rounds = [
        # s1 round 1: write the file; round 2: a short prose handoff
        [
            LLMChunk(
                delta_tool_calls=[
                    ToolCallDelta(
                        index=0,
                        id="c1",
                        function_name="file_write",
                        arguments_delta='{"path": "data/out.csv", "content": "a,b\\n1,2"}',
                    )
                ]
            )
        ],
        [LLMChunk(delta_content="已生成 data/out.csv")],
        # s2: final answer (single round)
        [LLMChunk(delta_content="分析完成")],
    ]
    provider = _ScriptedRounds(rounds)
    executor = build_agent_executor(
        plan=plan,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        base_tool_context=_ctx(),
        system_prompt="SYS",
        user_message="原始请求",
        execution_id="e",
    )
    res = await WaveScheduler().run(plan, executor)
    assert res["t_s1"].files_touched == ["data/out.csv"]
    assert res["t_s2"].phase is RunPhase.COMPLETED
    downstream_user = provider.user_messages[-1]  # the analyst's opening prompt
    assert "data/out.csv" in downstream_user  # got the pointer
    assert "file_read" in downstream_user
