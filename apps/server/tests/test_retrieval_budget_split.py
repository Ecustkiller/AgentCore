"""R-02 检索预算搜/读分池：默认值、按页计量、独立耗尽、分池剥工具与文案。"""

from __future__ import annotations

import pytest

from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.retrieval_budget import (
    DEFAULT_RETRIEVAL_BUDGET,
    READ_PAGE_CHARS,
    READ_TOOL_NAME,
    SEARCH_TOOL_NAME,
    apply_retrieval_budgets,
    default_retrieval_budget,
    default_retrieval_read_budget,
    exclude_retrieval_tools,
    format_retrieval_budget_line,
    read_pages_for_chars,
    retrieval_charge_quantity,
    retrieval_reserve_quantity,
)
from agentcore.runtime.runs.types import Deliverable, RunSpec
from agentcore.tools.protocol import RetrievalBudgetState, ToolResult


def _spec(*, budget: int | None = None, read_budget: int | None = None) -> RunSpec:
    return RunSpec(
        run_id="n1",
        task="t",
        role="r",
        depends_on=[],
        retrieval_budget=budget,
        retrieval_read_budget=read_budget,
    )


# ── 默认值 ────────────────────────────────────────────────────


def test_read_budget_defaults_to_search_pool_value():
    """读池默认与搜索池同值（settings 不可用时的回落）。"""
    assert READ_PAGE_CHARS == 2000
    assert default_retrieval_read_budget(_spec()) == DEFAULT_RETRIEVAL_BUDGET
    assert default_retrieval_read_budget(_spec()) == default_retrieval_budget(_spec())


def test_apply_fills_both_pools_independently():
    """apply 同时填搜索/读两字段；显式 0 保留 0（不回落）。"""
    s = _spec()
    apply_retrieval_budgets_to_spec(s)
    assert s.retrieval_budget == DEFAULT_RETRIEVAL_BUDGET
    assert s.retrieval_read_budget == DEFAULT_RETRIEVAL_BUDGET

    zero = _spec(budget=0, read_budget=0)
    apply_retrieval_budgets_to_spec(zero)
    assert zero.retrieval_budget == 0
    assert zero.retrieval_read_budget == 0


def apply_retrieval_budgets_to_spec(spec: RunSpec) -> None:
    from agentcore.runtime.runs.retrieval_budget import apply_retrieval_budgets_to_specs

    apply_retrieval_budgets_to_specs([spec])


# ── 按页计量 ──────────────────────────────────────────────────


def test_read_pages_for_chars_rounds_up_to_whole_pages():
    assert read_pages_for_chars(0) == 1  # 真实一次深读至少 1 页
    assert read_pages_for_chars(1) == 1
    assert read_pages_for_chars(2000) == 1
    assert read_pages_for_chars(2001) == 2
    assert read_pages_for_chars(8000) == 4


def test_retrieval_reserve_quantity_by_tool():
    assert retrieval_reserve_quantity(SEARCH_TOOL_NAME, {}) == 1
    assert retrieval_reserve_quantity(READ_TOOL_NAME, {}) == 4  # 默认 8000 字 → 4 页
    assert retrieval_reserve_quantity(READ_TOOL_NAME, {"max_chars": 8000}) == 4
    assert retrieval_reserve_quantity(READ_TOOL_NAME, {"max_chars": 2000}) == 1
    assert retrieval_reserve_quantity(READ_TOOL_NAME, {"max_chars": 50000}) == 15  # clamp 30000


def test_retrieval_charge_quantity_from_content_chars():
    live = ToolResult(tool_call_id="", success=True, output="x", metadata={"content_chars": 4500})
    assert retrieval_charge_quantity(READ_TOOL_NAME, live) == 3
    assert retrieval_charge_quantity(SEARCH_TOOL_NAME, live) == 1
    # 无 content_chars（stub 未回报）回落为 1 页，避免 0 页白嫖。
    bare = ToolResult(tool_call_id="", success=True, output="x", metadata={})
    assert retrieval_charge_quantity(READ_TOOL_NAME, bare) == 1


# ── 独立耗尽 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_any_exhausted_requires_both_pools_closed():
    # 只开搜索池、读池从未分配（read_limit=0）→ 不算「整体不可用」。
    rb = RetrievalBudgetState(limit=0, read_limit=0)
    assert rb.any_exhausted  # 两池全关（都没额度）
    # 有一池开放即不算整体不可用。
    rb2 = RetrievalBudgetState(limit=1, read_limit=0)
    assert not rb2.any_exhausted


# ── 分池剥工具 ────────────────────────────────────────────────


def test_exclude_retrieval_tools_only_strips_target():
    """only 参数只剥指定池对应工具；另一池保留。"""
    tools = ["web_search", "read_url", "file_read"]
    assert exclude_retrieval_tools(tools, None, only=frozenset({SEARCH_TOOL_NAME})) == [
        "read_url",
        "file_read",
    ]
    assert exclude_retrieval_tools(tools, None, only=frozenset({READ_TOOL_NAME})) == [
        "web_search",
        "file_read",
    ]
    assert exclude_retrieval_tools(tools, None) == ["file_read"]


def test_apply_strips_only_zero_pool_tool():
    """搜索 0 只卸 web_search，读池照常；读 0 只卸 read_url。"""
    valid = {"web_search", "read_url", "file_read"}
    spec = _spec(budget=0, read_budget=None)
    spec.tools = ["web_search", "read_url", "file_read"]
    from agentcore.runtime.runs.retrieval_budget import _apply_one

    _apply_one(spec, valid_tools=valid)
    assert "web_search" not in spec.tools
    assert "read_url" in spec.tools

    spec2 = _spec(budget=None, read_budget=0)
    spec2.tools = ["web_search", "read_url", "file_read"]
    _apply_one(spec2, valid_tools=valid)
    assert "read_url" not in spec2.tools
    assert "web_search" in spec2.tools


# ── 分池文案 ──────────────────────────────────────────────────


def test_budget_line_splits_search_and_read():
    line = format_retrieval_budget_line(5, 6)
    assert "web_search 最多 5 次" in line
    assert "read_url 最多 6 页" in line

    # 搜索关、读开。
    search_off = format_retrieval_budget_line(0, 6)
    assert "web_search 0 次（不装配）" in search_off
    assert "read_url 最多 6 页" in search_off

    # 读关、搜索开。
    read_off = format_retrieval_budget_line(5, 0)
    assert "web_search 最多 5 次" in read_off
    assert "read_url 0 页（不装配）" in read_off

    # 全关。
    both_off = format_retrieval_budget_line(0, 0)
    assert "web_search" in both_off and "read_url" in both_off
    assert "不装配" in both_off
