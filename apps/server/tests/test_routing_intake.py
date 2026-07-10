"""Worker 内部路由 Phase 1 — Intake 轻量计划头。"""

from __future__ import annotations

from agentcore.runtime.routing import (
    Complexity,
    ExecutionStrategy,
    assess_intake,
)


def test_simple_direct_execute():
    result = assess_intake(task="简单解释一下什么是 HTTP")
    assert result.complexity in (Complexity.SIMPLE, Complexity.MODERATE)
    assert result.strategy is ExecutionStrategy.DIRECT_EXECUTE
    assert result.token_budget > 0
    assert result.rationale


def test_research_strategy():
    result = assess_intake(task="调研竞品并检索最新行业报告")
    assert result.strategy is ExecutionStrategy.NEEDS_RESEARCH
    assert result.complexity in (Complexity.MODERATE, Complexity.COMPLEX)
    assert "research_keyword" in result.signals


def test_tools_strategy_from_keywords():
    result = assess_intake(task="实现文件写入并跑测试修复 lint")
    assert result.strategy is ExecutionStrategy.NEEDS_TOOLS
    assert "tool_keyword" in result.signals


def test_tools_granted_lifts_strategy():
    result = assess_intake(
        task="整理一下目录结构说明",
        tools=["file_list", "file_read"],
    )
    assert result.strategy is ExecutionStrategy.NEEDS_TOOLS
    assert "mutation_tool_granted" in result.signals


def test_complex_architecture_task():
    result = assess_intake(
        task="重新设计多模块架构并迁移跨服务接口契约，分阶段落地",
        role="架构师",
    )
    assert result.complexity is Complexity.COMPLEX
    assert result.token_budget >= 48_000


def test_event_payload_shape():
    result = assess_intake(task="写一个 hello world 文件")
    payload = result.to_event_payload()
    assert payload["complexity"] in ("simple", "moderate", "complex")
    assert payload["strategy"] in ("direct_execute", "needs_tools", "needs_research")
    assert isinstance(payload["token_budget"], int)
    assert isinstance(payload["signals"], list)
