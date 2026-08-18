"""Turn-level LLM **cost** ceiling: settings + meter + reject / wave short-circuit (R-01).

费用顶与 token 顶正交：``billed_nano``（platform/vendor 计费面）驱动硬顶，
``estimated_nano``（BYOK 自付估计）仅观测、**永不触顶**。计价仍走
:func:`agentcore.llm.pricing.calculate_cost` 单点，本模块只累进 meter、不复价。
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from agentcore.config.engine import EngineSettings
from agentcore.llm.observability import log_llm_call
from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.turn.cost_budget import (
    REASON_TURN_COST_BUDGET,
    bind_turn_cost_meter,
    cost_from_journal_entries,
    current_turn_cost_estimated_nano,
    current_turn_cost_nano,
    is_turn_cost_ceiling_hit,
    is_turn_cost_delivery_reserve_hit,
    record_turn_cost,
    reset_turn_cost_meter,
    turn_cost_budget_wrap_prompt,
    turn_cost_ceiling_reject_message,
)


def test_engine_turn_cost_ceiling_default():
    s = EngineSettings()
    assert s.engine_turn_cost_ceiling_nano == 0
    assert s.engine_turn_cost_delivery_reserve_nano == 0


def test_engine_turn_cost_ceiling_disable():
    s = EngineSettings(engine_turn_cost_ceiling_nano=0)
    assert s.engine_turn_cost_ceiling_nano == 0


def test_meter_records_billed_and_estimated():
    token = bind_turn_cost_meter(seed_billed=0, seed_estimated=0)
    try:
        assert current_turn_cost_nano() == 0
        assert current_turn_cost_estimated_nano() == 0
        record_turn_cost(60, 0)
        assert current_turn_cost_nano() == 60
        assert current_turn_cost_estimated_nano() == 0
        record_turn_cost(0, 40)
        assert current_turn_cost_nano() == 60
        assert current_turn_cost_estimated_nano() == 40
        record_turn_cost(0, 0)  # no-op when both zero
        assert current_turn_cost_nano() == 60
    finally:
        reset_turn_cost_meter(token)


def test_record_noop_without_bound_meter():
    record_turn_cost(999, 999)
    assert current_turn_cost_nano() == 0
    assert current_turn_cost_estimated_nano() == 0


def test_cost_ceiling_hit(monkeypatch):
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 100,
    )
    token = bind_turn_cost_meter(seed_billed=0, seed_estimated=0)
    try:
        assert not is_turn_cost_ceiling_hit()
        record_turn_cost(60, 0)
        assert not is_turn_cost_ceiling_hit()
        record_turn_cost(50, 0)
        assert current_turn_cost_nano() == 110
        assert is_turn_cost_ceiling_hit()
        msg = turn_cost_ceiling_reject_message()
        assert "费用" in msg
        assert "禁止新开派单" in msg
        assert "¥" in msg  # 金额以 CNY 呈现（nano 分度）
    finally:
        reset_turn_cost_meter(token)


def test_cost_ceiling_off_when_zero(monkeypatch):
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 0,
    )
    token = bind_turn_cost_meter(seed_billed=999_999, seed_estimated=0)
    try:
        assert not is_turn_cost_ceiling_hit()
    finally:
        reset_turn_cost_meter(token)


def test_estimated_spend_never_gates(monkeypatch):
    """BYOK estimated money (user's own out-of-pocket) must never trip billable ceiling."""
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 100,
    )
    token = bind_turn_cost_meter(seed_billed=0, seed_estimated=0)
    try:
        record_turn_cost(0, 500)
        assert current_turn_cost_nano() == 0
        assert current_turn_cost_estimated_nano() == 500
        assert not is_turn_cost_ceiling_hit()
    finally:
        reset_turn_cost_meter(token)


def test_delivery_reserve_hit_window(monkeypatch):
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 1000,
    )
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_delivery_reserve_nano",
        lambda: 200,
    )
    token = bind_turn_cost_meter(seed_billed=0, seed_estimated=0)
    try:
        assert not is_turn_cost_delivery_reserve_hit()
        record_turn_cost(799, 0)
        assert not is_turn_cost_delivery_reserve_hit()
        record_turn_cost(1, 0)  # 800 = ceiling - reserve
        assert is_turn_cost_delivery_reserve_hit()
        assert not is_turn_cost_ceiling_hit()
        record_turn_cost(200, 0)  # 1000 = hard ceiling
        assert is_turn_cost_ceiling_hit()
        assert not is_turn_cost_delivery_reserve_hit()  # hard owns the stop
    finally:
        reset_turn_cost_meter(token)


def test_delivery_reserve_off_when_reserve_ge_ceiling(monkeypatch):
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 100,
    )
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_delivery_reserve_nano",
        lambda: 100,
    )
    token = bind_turn_cost_meter(seed_billed=50, seed_estimated=0)
    try:
        assert not is_turn_cost_delivery_reserve_hit()
    finally:
        reset_turn_cost_meter(token)


def test_cost_from_journal_entries():
    entries = [
        {"kind": "turn_started", "payload": {}},
        {
            "kind": "run_completed",
            "payload": {"cost": {"total": 300, "credential_source": "platform"}},
        },
        {
            "kind": "run_completed",
            "payload": {"cost": {"total": 150, "credential_source": "user"}},
        },
        {
            "kind": "run_completed",
            "payload": {"cost": {"total": 0, "credential_source": "platform"}},
        },
        {"kind": "run_completed", "payload": {}},
        {"kind": "run_completed", "payload": "not-a-dict"},
    ]
    billed, estimated = cost_from_journal_entries(entries)
    assert billed == 300
    assert estimated == 150
    assert cost_from_journal_entries(None) == (0, 0)
    assert cost_from_journal_entries([{"kind": "llm_call", "payload": {}}]) == (0, 0)


def test_log_llm_call_feeds_cost_meter_platform(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.observability.settings.log_llm_bodies",
        False,
    )
    monkeypatch.setattr(
        "agentcore.llm.pricing.calculate_cost",
        lambda *a, **k: MagicMock(
            total=1234, credential_source="platform", pricing_source="curated"
        ),
    )
    monkeypatch.setattr(
        "agentcore.llm.pricing.resolve_credential_source",
        lambda **k: "platform",
    )
    token = bind_turn_cost_meter(seed_billed=0, seed_estimated=0)
    try:
        log_llm_call(
            scenario="agent",
            model="test-model",
            usage=TokenUsage(input_tokens=40, output_tokens=10),
            finish_reason="stop",
            latency_ms=1,
            stream=False,
        )
        assert current_turn_cost_nano() == 1234
        assert current_turn_cost_estimated_nano() == 0
    finally:
        reset_turn_cost_meter(token)


def test_log_llm_call_feeds_cost_meter_user_byok(monkeypatch):
    monkeypatch.setattr(
        "agentcore.llm.observability.settings.log_llm_bodies",
        False,
    )
    monkeypatch.setattr(
        "agentcore.llm.pricing.calculate_cost",
        lambda *a, **k: MagicMock(
            total=5678, credential_source="user", pricing_source="estimated"
        ),
    )
    monkeypatch.setattr(
        "agentcore.llm.pricing.resolve_credential_source",
        lambda **k: "user",
    )
    token = bind_turn_cost_meter(seed_billed=0, seed_estimated=0)
    try:
        log_llm_call(
            scenario="agent",
            model="test-model",
            usage=TokenUsage(input_tokens=40, output_tokens=10),
            finish_reason="stop",
            latency_ms=1,
            stream=False,
        )
        assert current_turn_cost_nano() == 0
        assert current_turn_cost_estimated_nano() == 5678
    finally:
        reset_turn_cost_meter(token)


def test_wrap_prompt_is_explicit_close_not_fake_done(monkeypatch):
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 100,
    )
    token = bind_turn_cost_meter(seed_billed=100, seed_estimated=0)
    try:
        text = turn_cost_budget_wrap_prompt()
        assert text.startswith("[系统提示]")
        assert "触顶" in text
        assert "¥" in text
        assert "delegate" in text or "派" in text
        assert "假" in text or "伪装" in text
        assert REASON_TURN_COST_BUDGET in text
        assert "下一回合" in text and "续跑" in text
        assert "禁止假装" in text or "伪装" in text
    finally:
        reset_turn_cost_meter(token)


def test_maybe_inject_turn_token_budget_gate_cost_ceiling(monkeypatch):
    from agentcore.llm.provider.protocol import LLMMessage
    from agentcore.runtime.engine.governance import (
        create_loop_controller,
        maybe_inject_turn_token_budget_gate,
        should_turn_token_budget_gate,
    )

    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 50,
    )
    token = bind_turn_cost_meter(seed_billed=50, seed_estimated=0)
    try:
        controller = create_loop_controller(frozenset())
        assert should_turn_token_budget_gate(controller, role="captain") is True
        assert should_turn_token_budget_gate(controller, role="worker") is False

        messages: list[LLMMessage] = []
        assert (
            maybe_inject_turn_token_budget_gate(
                controller,
                messages=messages,
                run_id="r1",
                round_idx=2,
                role="captain",
            )
            is True
        )
        assert len(messages) == 1
        content = messages[0].content or ""
        assert "触顶" in content
        assert REASON_TURN_COST_BUDGET in content
        assert controller.turn_token_budget_gate_fired is True

        # One-shot latch
        assert should_turn_token_budget_gate(controller, role="captain") is False
        assert (
            maybe_inject_turn_token_budget_gate(
                controller,
                messages=messages,
                run_id="r1",
                round_idx=3,
                role="captain",
            )
            is False
        )
        assert len(messages) == 1
    finally:
        reset_turn_cost_meter(token)


def test_wave_hooks_parent_stop_includes_cost_ceiling(monkeypatch):
    from agentcore.runtime.turn.token_budget import resolve_wave_budget_hooks

    # token ceiling off; cost ceiling hit → parent stop must still fire.
    monkeypatch.setattr(
        "agentcore.runtime.turn.token_budget.resolve_turn_token_ceiling",
        lambda: 0,
    )
    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 100,
    )
    token = bind_turn_cost_meter(seed_billed=100, seed_estimated=0)
    try:
        should_stop, _priority = resolve_wave_budget_hooks()
        assert should_stop() is True
    finally:
        reset_turn_cost_meter(token)


@pytest.mark.asyncio
async def test_materialise_turn_token_budget_skips_cost_ceiling(monkeypatch):
    from agentcore.runtime.delegate.drive import _materialise_turn_token_budget_skips
    from agentcore.runtime.runs.plan import RunPlan, RunSpec
    from agentcore.runtime.runs.types import RunPhase, RunState

    monkeypatch.setattr(
        "agentcore.runtime.turn.cost_budget.resolve_turn_cost_ceiling_nano",
        lambda: 100,
    )
    token = bind_turn_cost_meter(seed_billed=100, seed_estimated=0)
    try:
        assert is_turn_cost_ceiling_hit()
        plan = RunPlan()
        plan.add(RunSpec(run_id="done", role="a", task="t", agent_id="done"))
        plan.add(RunSpec(run_id="pending", role="b", task="t2", agent_id="pending"))
        results = {"done": RunState(phase=RunPhase.COMPLETED)}
        sink = MagicMock()
        tool = MagicMock()
        tool._sink = sink
        _materialise_turn_token_budget_skips(tool, plan, results)
        assert results["pending"].phase is RunPhase.SKIPPED
        assert results["pending"].delivery_gaps
        assert results["pending"].delivery_gaps[0]["reason"] == REASON_TURN_COST_BUDGET
        assert sink.emit.call_count == 1
    finally:
        reset_turn_cost_meter(token)
