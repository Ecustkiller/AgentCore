"""Unit tests for write-side always-entry quota (闸在写侧)."""

from __future__ import annotations

from agentcore.memory.always_quota import (
    AlwaysUsage,
    always_entry_chars,
    evaluate_always_write,
    project_usage_after,
)


def test_always_entry_chars_strips_frontmatter():
    raw = "---\napply: always\ndescription: x\n---\nhello"
    assert always_entry_chars(raw) == len("hello")


def test_always_entry_chars_unclosed_is_zero():
    assert always_entry_chars("---\napply: always\nno close") == 0


def test_user_edit_existing_always_over_limit_allows_with_warning():
    projected = AlwaysUsage(used_chars=30_000, max_chars=24_000, fingerprint="fp1")
    decision = evaluate_always_write(
        writer="user",
        editing_existing_always=True,
        current_used=20_000,
        projected=projected,
    )
    assert decision.allowed is True
    assert decision.warning is not None
    assert "24000" in decision.warning


def test_user_create_over_limit_denied():
    projected = AlwaysUsage(used_chars=30_000, max_chars=24_000, fingerprint="fp1")
    decision = evaluate_always_write(
        writer="user",
        editing_existing_always=False,
        current_used=20_000,
        projected=projected,
    )
    assert decision.allowed is False
    assert decision.message is not None


def test_ai_growth_over_limit_denied():
    projected = AlwaysUsage(used_chars=25_000, max_chars=24_000, fingerprint="fp1")
    decision = evaluate_always_write(
        writer="ai",
        editing_existing_always=True,
        current_used=20_000,
        projected=projected,
    )
    assert decision.allowed is False


def test_ai_shrink_while_over_allowed():
    projected = AlwaysUsage(used_chars=24_500, max_chars=24_000, fingerprint="fp1")
    decision = evaluate_always_write(
        writer="ai",
        editing_existing_always=True,
        current_used=30_000,
        projected=projected,
    )
    assert decision.allowed is True
    assert decision.warning is None


def test_under_limit_always_allowed():
    projected = AlwaysUsage(used_chars=100, max_chars=24_000, fingerprint="fp")
    for writer, existing in (("user", False), ("user", True), ("ai", True)):
        d = evaluate_always_write(
            writer=writer,
            editing_existing_always=existing,
            current_used=50,
            projected=projected,
        )
        assert d.allowed is True
        assert d.warning is None


def test_quota_disabled_when_max_zero():
    projected = AlwaysUsage(used_chars=999_999, max_chars=0, fingerprint="fp")
    d = evaluate_always_write(
        writer="ai",
        editing_existing_always=False,
        current_used=0,
        projected=projected,
    )
    assert d.allowed is True


def test_always_usage_percent():
    u = AlwaysUsage(used_chars=12_000, max_chars=24_000)
    assert u.percent == 50.0
    assert u.over_limit is False
    assert AlwaysUsage(used_chars=25_000, max_chars=24_000).over_limit is True


class _Doc:
    def __init__(self, id: str, content: str) -> None:
        self.id = id
        self.content = content


def test_project_usage_after_replaces_excluded():
    docs = [
        _Doc("a", "---\napply: always\n---\n" + ("x" * 100)),
        _Doc("b", "---\napply: always\n---\n" + ("y" * 50)),
    ]
    # type: ignore[arg-type] — duck-typed for the helper
    projected = project_usage_after(
        docs,  # type: ignore[arg-type]
        exclude_id="a",
        new_chars=200,
        new_is_always=True,
    )
    assert projected.used_chars == 250
