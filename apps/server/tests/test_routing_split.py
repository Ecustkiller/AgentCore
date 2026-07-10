"""Worker 内部路由 Phase 2 — Sequential Split 触发 / 评估 / Sub-Worker 生命周期。"""

from __future__ import annotations

import pytest

from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.routing import (
    SplitBudget,
    SplitDecision,
    SplitTrigger,
    SubTaskSpec,
    SubWorkerBrief,
    SubWorkerResult,
    aggregate_results,
    allocate_subtask_budgets,
    assess_split,
    briefs_from_decision,
    build_subworker_brief,
    detect_split_pressure,
    extract_result_from_content,
    fold_results_for_parent,
    summarize_parent_progress,
    total_tool_failures,
)


def _budget(*, steps: int = 10, tokens: int = 10_000) -> SplitBudget:
    return SplitBudget(max_steps=steps, max_tokens=tokens)


# ---- pressure detection ----------------------------------------------------


def test_no_pressure_when_under_thresholds():
    pressure = detect_split_pressure(
        current_step_count=3,
        token_consumed=1000,
        tool_failure_count=1,
        budget=_budget(),
    )
    assert not pressure.is_pressured
    assert pressure.triggers == []


def test_step_pressure_triggers():
    # max_steps=10 → threshold = 6; need > 6
    pressure = detect_split_pressure(
        current_step_count=7,
        token_consumed=0,
        tool_failure_count=0,
        budget=_budget(steps=10),
    )
    assert pressure.is_pressured
    assert SplitTrigger.STEPS in pressure.triggers


def test_token_pressure_triggers():
    # max_tokens=10000 → threshold = 7000; need > 7000
    pressure = detect_split_pressure(
        current_step_count=1,
        token_consumed=7001,
        tool_failure_count=0,
        budget=_budget(tokens=10_000),
    )
    assert SplitTrigger.TOKENS in pressure.triggers


def test_tool_failure_pressure_triggers():
    pressure = detect_split_pressure(
        current_step_count=1,
        token_consumed=0,
        tool_failure_count=3,
        budget=_budget(),
    )
    assert SplitTrigger.TOOL_FAILURES in pressure.triggers


def test_multiple_triggers():
    pressure = detect_split_pressure(
        current_step_count=8,
        token_consumed=8000,
        tool_failure_count=5,
        budget=_budget(steps=10, tokens=10_000),
    )
    assert set(pressure.triggers) == {
        SplitTrigger.STEPS,
        SplitTrigger.TOKENS,
        SplitTrigger.TOOL_FAILURES,
    }


# ---- assess / depth limit --------------------------------------------------


def test_assess_no_split_without_pressure():
    pressure = detect_split_pressure(
        current_step_count=1,
        token_consumed=0,
        tool_failure_count=0,
        budget=_budget(),
    )
    decision = assess_split(pressure=pressure, task="做点事")
    assert not decision.should_split
    assert decision.subtasks == []


def test_assess_splits_on_step_pressure():
    pressure = detect_split_pressure(
        current_step_count=7,
        token_consumed=1000,
        tool_failure_count=0,
        budget=_budget(steps=10, tokens=10_000),
    )
    decision = assess_split(
        pressure=pressure,
        task="实现多模块迁移",
        parent_progress_summary="已读完代码",
        remaining_token_budget=8000,
    )
    assert decision.should_split
    assert len(decision.subtasks) == 2
    assert all(s.token_budget > 0 for s in decision.subtasks)
    assert all(
        any("不可再分裂" in c for c in s.constraints) for s in decision.subtasks
    )


def test_assess_tool_failure_single_subtask():
    pressure = detect_split_pressure(
        current_step_count=1,
        token_consumed=0,
        tool_failure_count=3,
        budget=_budget(),
    )
    decision = assess_split(
        pressure=pressure,
        task="修 lint",
        remaining_token_budget=5000,
    )
    assert decision.should_split
    assert len(decision.subtasks) == 1
    assert "换策略" in decision.subtasks[0].goal


def test_depth_limit_can_split_false():
    pressure = detect_split_pressure(
        current_step_count=9,
        token_consumed=9000,
        tool_failure_count=5,
        budget=_budget(steps=10, tokens=10_000),
    )
    decision = assess_split(
        pressure=pressure,
        task="任何任务",
        remaining_token_budget=5000,
        can_split=False,
    )
    assert not decision.should_split
    assert "depth" in decision.rationale.lower() or "can_split" in decision.rationale


def test_assess_fn_override():
    pressure = detect_split_pressure(
        current_step_count=7,
        token_consumed=0,
        tool_failure_count=0,
        budget=_budget(steps=10),
    )

    def fake_assess(**_kwargs: object) -> SplitDecision:
        return SplitDecision(
            should_split=True,
            rationale="llm says so",
            triggers=[SplitTrigger.STEPS],
            subtasks=[
                SubTaskSpec(goal="子任务 A", token_budget=1000),
            ],
        )

    decision = assess_split(
        pressure=pressure,
        task="x",
        remaining_token_budget=5000,
        assess_fn=fake_assess,
    )
    assert decision.should_split
    assert decision.subtasks[0].goal == "子任务 A"


def test_remaining_budget_too_small_no_split():
    pressure = detect_split_pressure(
        current_step_count=7,
        token_consumed=9900,
        tool_failure_count=0,
        budget=_budget(steps=10, tokens=10_000),
    )
    decision = assess_split(
        pressure=pressure,
        task="x",
        remaining_token_budget=100,
    )
    assert not decision.should_split


# ---- Sub-Worker lifecycle / context / fold ---------------------------------


def test_subworker_brief_depth_hard_limit():
    spec = SubTaskSpec(goal="写测试", constraints=["不可再分裂子任务"], token_budget=2000)
    brief = build_subworker_brief(
        spec=spec,
        parent_run_id="run1",
        parent_agent_id="agent1",
        parent_progress_summary="已完成调研",
    )
    assert brief.can_split is False
    assert brief.depth == 1
    assert brief.goal == "写测试"
    assert "不可再分裂" in brief.to_user_message()
    assert "已完成调研" in brief.to_user_message()
    payload = brief.to_event_payload()
    assert payload["can_split"] is False
    assert payload["token_budget"] == 2000


def test_briefs_from_decision_ordered():
    decision = SplitDecision(
        should_split=True,
        subtasks=[
            SubTaskSpec(goal="第一步", token_budget=1000),
            SubTaskSpec(goal="第二步", token_budget=1000),
        ],
        triggers=[SplitTrigger.STEPS],
    )
    briefs = briefs_from_decision(decision=decision, parent_run_id="r", parent_agent_id="a")
    assert len(briefs) == 2
    assert briefs[0].goal == "第一步"
    assert briefs[1].goal == "第二步"
    assert all(b.can_split is False for b in briefs)


def test_extract_and_fold_results():
    usage = TokenUsage(input_tokens=100, output_tokens=50)
    result = extract_result_from_content(
        subworker_id="sw_abc",
        content="已写入 apps/server/foo.py 并更新了配置。\n修改了 bar.ts",
        usage=usage,
        rounds=3,
    )
    assert result.success
    assert result.tokens_used == 150
    assert result.rounds == 3
    assert any("foo.py" in a for a in result.artifact_refs)
    assert result.side_effects  # 写入 / 修改 hints

    failed = SubWorkerResult(
        subworker_id="sw_fail",
        success=False,
        summary="",
        failure="TimeoutError: boom",
        tokens_used=10,
        rounds=1,
    )
    fold = fold_results_for_parent([result, failed])
    assert "Sub-Worker" in fold
    assert "sw_abc" in fold
    assert "sw_fail" in fold
    assert "failed" in fold

    agg = aggregate_results([result, failed])
    assert agg["count"] == 2
    assert agg["success_count"] == 1
    assert agg["failure_count"] == 1
    assert agg["tokens_used"] == 160


@pytest.mark.asyncio
async def test_sequential_subworkers_run_in_order():
    from agentcore.runtime.routing.subworker import run_sequential_subworkers

    order: list[str] = []

    async def fake_runner(*, brief: SubWorkerBrief, **_kwargs: object) -> SubWorkerResult:
        order.append(brief.subworker_id)
        return SubWorkerResult(
            subworker_id=brief.subworker_id,
            success=True,
            summary=f"done {brief.goal}",
            tokens_used=10,
            rounds=1,
        )

    briefs = [
        SubWorkerBrief(
            subworker_id="sw_1",
            goal="A",
            token_budget=1000,
            can_split=False,
        ),
        SubWorkerBrief(
            subworker_id="sw_2",
            goal="B",
            token_budget=1000,
            can_split=False,
        ),
    ]
    # Minimal stubs — runner short-circuits before using them.
    results = await run_sequential_subworkers(
        briefs=briefs,
        llm=None,  # type: ignore[arg-type]
        tools=None,  # type: ignore[arg-type]
        sink=None,  # type: ignore[arg-type]
        tool_context=None,  # type: ignore[arg-type]
        turn_model="test-model",
        runner=fake_runner,
    )
    assert order == ["sw_1", "sw_2"]
    assert [r.summary for r in results] == ["done A", "done B"]


def test_allocate_budgets_reserves_parent_slice():
    budgets = allocate_subtask_budgets(remaining_token_budget=4000, subtask_count=2)
    assert len(budgets) == 2
    assert sum(budgets) <= 4000  # parent reserve kept out of pool
    assert all(b >= 500 for b in budgets)


def test_summarize_and_total_failures():
    summary = summarize_parent_progress(
        rounds_completed=5,
        tool_names=["file_read", "file_read", "code_execute"],
        content_preview="草稿一段",
    )
    assert "5 轮" in summary
    assert "file_read" in summary
    assert "code_execute" in summary
    assert total_tool_failures({"a": 2, "b": 1}) == 3
    assert total_tool_failures({}) == 0
