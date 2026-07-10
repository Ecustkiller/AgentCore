"""Unit tests for the thin team_preview gate (方案 A)."""

from __future__ import annotations

from types import SimpleNamespace

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunSpec
from agentcore.tools.builtin.delegate.preview import (
    should_preview,
    skip_after_confirmed_ask,
    worker_rows,
)
from agentcore.tools.builtin.delegate.steer import apply_steer


def _plan(*nodes: RunSpec) -> RunPlan:
    plan = RunPlan()
    for n in nodes:
        plan.add(n)
    return plan


def test_should_preview_multi_worker():
    plan = _plan(
        RunSpec(run_id="r1", task="a", role="调研"),
        RunSpec(run_id="r2", task="b", role="撰写", depends_on=["r1"]),
    )
    assert should_preview(plan, finalize=False) is True
    assert should_preview(plan, finalize=True) is True


def test_should_preview_skips_solo_finalize():
    plan = _plan(RunSpec(run_id="r1", task="alone", role="写手"))
    assert should_preview(plan, finalize=True) is False
    assert should_preview(plan, finalize=False) is False


def test_should_preview_debate_marked_solo():
    plan = _plan(RunSpec(run_id="r1", task="辩", role="正方", stance="pro", round=1))
    assert should_preview(plan, finalize=True) is True


def test_skip_after_confirmed_ask():
    tool = SimpleNamespace(
        _sink=SimpleNamespace(
            execution_journal=lambda: [
                {"type": "checkpoint_required", "payload": {}},
                {"type": "checkpoint_resolved", "payload": {"decision": "continue"}},
            ]
        )
    )
    assert skip_after_confirmed_ask(tool) is True
    tool_nb = SimpleNamespace(
        _sink=SimpleNamespace(
            execution_journal=lambda: [{"type": "question_posted", "payload": {}}]
        )
    )
    assert skip_after_confirmed_ask(tool_nb) is False
    tool_empty = SimpleNamespace(_sink=SimpleNamespace(execution_journal=lambda: None))
    assert skip_after_confirmed_ask(tool_empty) is False


def test_worker_rows_shape():
    plan = _plan(
        RunSpec(run_id="r1", task="调研方案", role="调研"),
        RunSpec(run_id="r2", task="写", role="撰写", depends_on=["r1"], stance="con"),
    )
    rows = worker_rows(plan)
    assert rows[0]["role"] == "调研"
    assert rows[0]["debate"] is False
    assert rows[1]["depends_on"] == ["r1"]
    assert rows[1]["debate"] is True


def test_apply_steer_empty_roots_targets_all():
    plan = _plan(
        RunSpec(run_id="r1", task="a", role="A"),
        RunSpec(run_id="r2", task="b", role="B", depends_on=["r1"]),
    )
    apply_steer(plan, {}, set(), "请更简洁")
    assert "请更简洁" in (plan.by_id("r1").steer or "")
    assert "请更简洁" in (plan.by_id("r2").steer or "")
