"""Unit tests for delegate completion soft checks (S3: no criteria kind)."""

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.delegate.completion import (
    check_delegate_completion,
    collect_worker_gaps,
    format_worker_gaps_block,
    plan_suggests_code_verification,
    validate_cold_start_explore_deliverables,
    validate_repair_how_fixed,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState


def _run(*, files: list[str] | None = None, transcript: list[LLMMessage] | None = None):
    return RunState(
        phase=RunPhase.COMPLETED,
        content="done",
        files_touched=files or [],
        transcript=transcript or [],
    )


def test_omitted_criteria_always_ok():
    ok, gaps, soft = check_delegate_completion({"a": _run()})
    assert ok
    assert gaps == []
    assert soft == []


def test_soft_overlay_typescript_without_verify():
    ok, gaps, soft = check_delegate_completion({"a": _run(files=["src/App.tsx"])})
    assert ok
    assert gaps == []
    assert any("不阻断验收" in n and ".ts" in n for n in soft)


def test_soft_overlay_skipped_when_test_run_passes():
    transcript = [
        LLMMessage(
            role="assistant",
            content="",
            tool_calls=[
                ToolCall(
                    id="1",
                    type="function",
                    function=ToolCallFunction(name="test_run", arguments='{"check":"test"}'),
                )
            ],
        ),
        LLMMessage(role="tool", tool_call_id="1", content="## 验证结果：通过\n通过：1"),
    ]
    ok, gaps, soft = check_delegate_completion(
        {"a": _run(files=["src/App.tsx"], transcript=transcript)}
    )
    assert ok
    assert gaps == []
    assert not any("建议补一次验证" in n for n in soft)


def test_plan_suggests_code_verification():
    plan = RunPlan(
        nodes=[
            RunSpec(
                run_id="a",
                role="dev",
                task="跑通测试并修好",
                objective="",
            )
        ]
    )
    assert plan_suggests_code_verification(plan)


def test_cold_start_explore_requires_two_workers():
    thin = RunPlan(
        nodes=[RunSpec(run_id="a", role="explorer", task="摸仓", objective="")]
    )
    msg = validate_cold_start_explore_deliverables(thin)
    assert msg is not None
    assert "≥2" in msg

    wide = RunPlan(
        nodes=[
            RunSpec(run_id="a", role="A", task="目录", objective=""),
            RunSpec(run_id="b", role="B", task="文档", objective=""),
        ]
    )
    assert validate_cold_start_explore_deliverables(wide) is None


def test_repair_how_fixed_playbook_only():
    assert validate_repair_how_fixed(playbook="repair_code", playbook_args={}) is not None
    assert (
        validate_repair_how_fixed(
            playbook="repair_code", playbook_args={"verify": "pytest -q"}
        )
        is None
    )
    assert validate_repair_how_fixed(playbook=None, playbook_args={}) is None


def test_format_worker_gaps_block_empty():
    assert format_worker_gaps_block([]) == ""


def test_collect_worker_gaps_empty_when_clean():
    plan = RunPlan(
        nodes=[RunSpec(run_id="a", role="dev", task="写", objective="")]
    )
    assert collect_worker_gaps(plan, {"a": _run(files=["a.py"])}) == []
