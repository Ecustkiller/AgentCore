"""Unit tests for delegate completion soft checks (S3: no criteria kind)."""

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.delegate.completion import (
    collect_completion_soft_notes,
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


def test_omitted_criteria_yields_no_soft_notes():
    soft = collect_completion_soft_notes({"a": _run()})
    assert soft == []


def test_soft_overlay_typescript_without_verify():
    soft = collect_completion_soft_notes({"a": _run(files=["src/App.tsx"])})
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
    soft = collect_completion_soft_notes(
        {"a": _run(files=["src/App.tsx"], transcript=transcript)}
    )
    assert not any("建议补一次验证" in n for n in soft)


def test_plan_suggests_code_verification():
    plan = RunPlan(
        nodes=[
            RunSpec(
                run_id="a",
                role="dev",
                task="跑通测试并修好",
            )
        ]
    )
    assert plan_suggests_code_verification(plan)


def test_plan_suggests_code_verification_skips_bare_open():
    """裸「打开文件 / 打开 .mdc」不得命中 plan_suggests_code_verification。"""
    for task in ("打开文件", "打开 `.cursor/rules/x.mdc`"):
        plan = RunPlan(
            nodes=[RunSpec(run_id="a", role="dev", task=task)]
        )
        assert not plan_suggests_code_verification(plan)


def test_plan_suggests_code_verification_open_acceptance():
    """「打开验收」仍经「验收」命中。"""
    plan = RunPlan(
        nodes=[RunSpec(run_id="a", role="dev", task="打开验收")]
    )
    assert plan_suggests_code_verification(plan)


def test_cold_start_explore_requires_two_workers():
    thin = RunPlan(
        nodes=[RunSpec(run_id="a", role="explorer", task="摸仓")]
    )
    msg = validate_cold_start_explore_deliverables(thin)
    assert msg is not None
    assert "≥2" in msg

    wide = RunPlan(
        nodes=[
            RunSpec(run_id="a", role="A", task="目录"),
            RunSpec(run_id="b", role="B", task="文档"),
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
    assert (
        validate_repair_how_fixed(
            playbook="repair_code",
            playbook_args={"verify": "打开 /app 白屏消失+snapshot 可见主内容"},
        )
        is None
    )
    assert validate_repair_how_fixed(playbook=None, playbook_args={}) is None
    missing = validate_repair_how_fixed(playbook="repair_code", playbook_args={})
    assert missing is not None
    assert "白屏" in missing or "snapshot" in missing


def test_format_worker_gaps_block_empty():
    assert format_worker_gaps_block([]) == ""


def test_collect_worker_gaps_empty_when_clean():
    plan = RunPlan(
        nodes=[RunSpec(run_id="a", role="dev", task="写")]
    )
    assert collect_worker_gaps(plan, {"a": _run(files=["a.py"])}) == []
