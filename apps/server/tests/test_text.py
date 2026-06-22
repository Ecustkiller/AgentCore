"""Unit tests for the leaf text primitive ``core.text.truncate_head_tail``."""

from __future__ import annotations

from agentcore.core.text import DEFAULT_ELISION_MARKER, truncate_head_tail


def test_keeps_both_ends_with_marker_between():
    content = "HEAD起始" + ("x" * 5_000) + "TAIL尾注金额￥999"
    out = truncate_head_tail(content, 1_000)
    assert out.startswith("HEAD起始")  # head (framing) kept
    assert out.endswith("TAIL尾注金额￥999")  # tail kept — a head-only cut drops it
    assert "中间省略" in out  # default elision marker
    assert len(out) <= 1_000  # never exceeds the allowance


def test_noop_when_within_limit():
    assert truncate_head_tail("short", 1_000) == "short"


def test_empty_when_limit_non_positive():
    assert truncate_head_tail("anything", 0) == ""
    assert truncate_head_tail("anything", -5) == ""


def test_custom_marker_is_used():
    out = truncate_head_tail("HEAD" + ("x" * 500) + "TAIL", 120, marker="\n…我的标记…\n")
    assert "我的标记" in out
    assert DEFAULT_ELISION_MARKER not in out
    assert out.startswith("HEAD")
    assert out.endswith("TAIL")


def test_degenerate_tiny_budget_falls_back_to_head_plus_ellipsis():
    # Budget smaller than the marker → head-only cut + ellipsis (real budgets never hit).
    out = truncate_head_tail("a" * 100, 10)
    assert out.startswith("a")
    assert out.endswith("…")
