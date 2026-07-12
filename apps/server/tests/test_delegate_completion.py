"""Unit tests for delegate completion_criteria verification."""

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import Deliverable, RunPhase, RunSpec, RunState
from agentcore.tools.builtin.delegate.completion import (
    check_delegate_completion,
    collect_worker_gaps,
    format_completion_gap_message,
    format_worker_gaps_block,
    parse_completion_criteria,
    plan_suggests_code_verification,
    resolve_completion_criteria,
)


def _run(*, files: list[str] | None = None, transcript: list[LLMMessage] | None = None):
    return RunState(
        phase=RunPhase.COMPLETED,
        content="done",
        files_touched=files or [],
        transcript=transcript or [],
    )


def test_parse_defaults_to_no_enforcement_when_omitted():
    assert parse_completion_criteria(None) is None
    assert parse_completion_criteria("code_verified").kind == "code_verified"


def test_omitted_criteria_is_backward_compatible():
    criteria = parse_completion_criteria(None)
    ok, gaps = check_delegate_completion(criteria, {"a": _run()})
    assert ok
    assert gaps == []


def test_files_written_requires_workspace_write():
    criteria = parse_completion_criteria("files_written")
    ok, gaps = check_delegate_completion(criteria, {"a": _run()})
    assert not ok
    assert "落盘" in gaps[0]

    ok, gaps = check_delegate_completion(criteria, {"a": _run(files=["main.py"])})
    assert ok
    assert gaps == []


def test_code_verified_requires_successful_code_execute():
    criteria = parse_completion_criteria("code_verified")
    ok, _ = check_delegate_completion(criteria, {"a": _run()})
    assert not ok

    transcript = [
        LLMMessage(
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="tc1",
                    type="function",
                    function=ToolCallFunction(name="code_execute", arguments="{}"),
                )
            ],
        ),
        LLMMessage(role="tool", content="stdout:\n1\n", tool_call_id="tc1"),
    ]
    ok, gaps = check_delegate_completion(criteria, {"a": _run(transcript=transcript)})
    assert ok
    assert gaps == []


def test_format_completion_gap_message():
    msg = format_completion_gap_message(["缺文件", "缺验证"])
    assert "完成条件未满足" in msg
    assert "缺文件" in msg


def test_plan_suggests_code_verification_on_run_open_tasks():
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="修复启动问题并验证进程能打开"),
        ],
    )
    assert plan_suggests_code_verification(plan)


def test_resolve_infers_code_verified_when_omitted_and_task_implies_run():
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="npm run start 跑通")])
    criteria = resolve_completion_criteria(None, plan)
    assert criteria is not None
    assert criteria.kind == "code_verified"


def test_resolve_keeps_legacy_no_enforcement_for_doc_tasks():
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="写一份产品说明文档")])
    assert resolve_completion_criteria(None, plan) is None


def test_resolve_enables_files_written_when_artifacts_declared():
    plan = RunPlan(
        nodes=[
            RunSpec(
                run_id="w1",
                task="集成",
                deliverable=Deliverable(artifacts=["README.md", "examples/*"]),
            )
        ]
    )
    criteria = resolve_completion_criteria(None, plan)
    assert criteria is not None
    assert criteria.kind == "files_written"


def test_collect_worker_gaps_surfaces_warnings_and_degraded_handoff():
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", role="集成岗", task="t"),
            RunSpec(run_id="b", role="架构师", task="t"),
        ]
    )
    results = {
        "a": RunState(
            phase=RunPhase.COMPLETED,
            content="x",
            warnings=["声明的交付物路径未落盘：`README.md`"],
        ),
        "b": RunState(
            phase=RunPhase.COMPLETED,
            content="y",
            debrief={"summary": "合成", "degraded": True},
        ),
    }
    gaps = collect_worker_gaps(plan, results)
    assert len(gaps) == 2
    block = format_worker_gaps_block(gaps)
    assert "契约缺口" in block
    assert "集成岗" in block
    assert "架构师" in block
    assert "降级合成" in block


def test_code_verified_accepts_test_run_with_zero_failures():
    criteria = parse_completion_criteria("code_verified")
    transcript = [
        LLMMessage(
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="tc1",
                    type="function",
                    function=ToolCallFunction(name="test_run", arguments="{}"),
                )
            ],
        ),
        LLMMessage(
            role="tool",
            content="### 摘要\n- 通过：3 / 失败：0 / 错误：0",
            tool_call_id="tc1",
        ),
    ]
    ok, gaps = check_delegate_completion(criteria, {"a": _run(transcript=transcript)})
    assert ok
    assert gaps == []


def _run_empty_body(*, files: list[str] | None = None, debrief: dict | None = None):
    """COMPLETED worker that finished via 落盘 / handoff with no streamed prose."""
    return RunState(
        phase=RunPhase.COMPLETED,
        content="",
        files_touched=files or [],
        debrief=debrief,
        transcript=[],
    )


def test_files_written_empty_body_with_disk_write_passes():
    """Pure file_write finish (empty content) must still satisfy files_written."""
    criteria = parse_completion_criteria("files_written")
    ok, gaps = check_delegate_completion(
        criteria, {"a": _run_empty_body(files=["index.html"])}
    )
    assert ok
    assert gaps == []


def test_files_written_empty_body_without_evidence_is_gap_not_vacuous_pass():
    """COMPLETED + empty body + no 落盘 must gap — never vacuous-pass the empty set."""
    criteria = parse_completion_criteria("files_written")
    ok, gaps = check_delegate_completion(
        criteria,
        {"a": _run_empty_body(debrief={"summary": "写完了"})},
    )
    assert not ok
    assert "落盘" in gaps[0]


def test_code_verified_empty_body_without_verify_is_gap():
    criteria = parse_completion_criteria("code_verified")
    ok, gaps = check_delegate_completion(criteria, {"a": _run_empty_body()})
    assert not ok
    assert "code_execute" in gaps[0] or "验证" in gaps[0]
