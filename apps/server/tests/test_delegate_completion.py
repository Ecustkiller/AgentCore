"""Unit tests for delegate completion_criteria verification."""

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.tools.builtin.delegate.completion import (
    check_delegate_completion,
    format_completion_gap_message,
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
