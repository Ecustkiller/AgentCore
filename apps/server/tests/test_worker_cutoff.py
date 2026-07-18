"""Worker 掐断透明化 (C) + 收尾窗口 (B)：原因码、超时预警、预算软顶。"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.coordination.session import (
    CoordinationEventKind,
    CoordinationSession,
    clear_active_coordination,
    set_active_coordination,
)
from agentcore.runtime.delegate.completion import (
    collect_worker_gaps,
    format_worker_gaps_block,
)
from agentcore.runtime.delegate.delivery_status import build_delivery_status
from agentcore.runtime.engine.ceiling import ceiling_finalize
from agentcore.runtime.events import FinishReason
from agentcore.runtime.runs.cutoff import (
    DEGRADED_HANDOFF_WARNING,
    REASON_DEGRADED_HANDOFF,
    REASON_TOKEN_BUDGET,
    REASON_WORKER_TIMEOUT,
    TOKEN_BUDGET_WARNING,
    WIND_DOWN_ALLOWED_TOOLS,
    WORKER_TIMEOUT_WARNING,
    narrow_tools_for_wind_down,
    should_enter_token_wind_down,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState


def test_collect_worker_gaps_emits_reason_codes():
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="调研", role="研究员"),
            RunSpec(run_id="w2", task="做PPT", role="设计师", depends_on=["w1"]),
        ]
    )
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED,
            content="调研稿",
            warnings=[TOKEN_BUDGET_WARNING],
        ),
        "w2": RunState(
            phase=RunPhase.COMPLETED,
            content="脚本",
            files_touched=["build.py"],
            warnings=[WORKER_TIMEOUT_WARNING],
            debrief={"summary": "合成", "degraded": True},
        ),
    }
    gaps = collect_worker_gaps(plan, results)
    by_role = {role: rows for role, rows in gaps}
    assert by_role["研究员"][0]["reason"] == REASON_TOKEN_BUDGET
    reasons_w2 = {r.get("reason") for r in by_role["设计师"]}
    assert REASON_WORKER_TIMEOUT in reasons_w2
    assert REASON_DEGRADED_HANDOFF in reasons_w2

    payload = build_delivery_status(plan, results, execution_id="e-cut")
    assert payload is not None
    assert payload["state"] == "partial"
    coded = [g for g in payload["gaps"] if g.get("reason")]
    assert {g["reason"] for g in coded} >= {
        REASON_TOKEN_BUDGET,
        REASON_WORKER_TIMEOUT,
        REASON_DEGRADED_HANDOFF,
    }

    block = format_worker_gaps_block(gaps)
    assert "综述强制" in block
    assert REASON_TOKEN_BUDGET in block
    assert DEGRADED_HANDOFF_WARNING in block


@pytest.mark.asyncio
async def test_ceiling_finalize_stamps_token_budget_on_track():
    """正轨撞顶：不标 DEGRADED，但 cutoff_reason_sink 写入 token_budget。"""
    cutoff: list[str] = []
    finish: list[FinishReason] = []
    controller = MagicMock()
    controller.is_thrashing.return_value = False

    class _ForceFinalize:
        async def __call__(self, **_kwargs):
            return "已有产出", "", TokenUsage(), 4, None

    with patch(
        "agentcore.runtime.engine.ceiling.force_finalize",
        new=_ForceFinalize(),
    ):
        await ceiling_finalize(
            messages=[],
            llm=MagicMock(),
            profile=MagicMock(max_rounds=28),
            active_model="m",
            base_model="m",
            tools=MagicMock(),
            allowed_tool_names=None,
            disabled_tools=set(),
            emit_content=lambda _d: None,
            emit_reasoning=lambda _d: None,
            emit_reset=lambda _r: None,
            final_content="已有产出",
            final_reasoning="",
            total_usage=TokenUsage(input_tokens=70_000, output_tokens=15_000),
            ceiling_reason="token_budget",
            round_idx=4,
            role="worker",
            run_id="del_w1",
            token_budget=80_000,
            controller=controller,
            tool_context=MagicMock(agent_id="a1"),
            sink=MagicMock(),
            finish_override_sink=finish,
            gate_escalation_sink=[],
            cutoff_reason_sink=cutoff,
        )
    assert cutoff == [REASON_TOKEN_BUDGET]
    assert finish == []  # 正轨不标 DEGRADED


@pytest.mark.asyncio
async def test_timeout_warn_before_notify():
    """超时两段式：warn 先于 CEO TIMEOUT；consume 供收尾窗口；不自动取消。"""
    clear_active_coordination()
    session = CoordinationSession(execution_id="exec-warn", total_workers=1)
    set_active_coordination(session)
    with patch("agentcore.config.settings") as settings:
        settings.engine_worker_timeout_warn_ratio = 0.4
        session.arm_worker_timeout("w-slow", role="慢工", timeout_s=0.1)
        # 等到 warn 窗口（0.04s）之后、硬通知（0.1s）之前
        await asyncio.sleep(0.06)
        assert session.consume_timeout_wind_down("w-slow") is True
        assert session.consume_timeout_wind_down("w-slow") is False  # once
        assert not session.was_timeout_notified("w-slow")
        events = await session.wait_events(timeout=1.0)
        assert any(e.kind is CoordinationEventKind.TIMEOUT for e in events)
        assert session.was_timeout_notified("w-slow")
        assert "w-slow" not in session.cancel_run_ids()
    session.disarm_worker_timeout("w-slow")
    clear_active_coordination()


def test_token_wind_down_threshold_and_tool_narrowing():
    """收尾窗口：85% 软顶阈值 + 工具收窄到落盘/handoff（剔除调查类）。"""
    assert should_enter_token_wind_down(68_000, 80_000, 0.85) is True
    assert should_enter_token_wind_down(67_999, 80_000, 0.85) is False
    assert should_enter_token_wind_down(80_000, 80_000, 0.0) is False  # ratio off
    assert should_enter_token_wind_down(10, 0, 0.85) is False  # budget off

    available = {"web_search", "handoff", "file_write", "file_list", "code_execute"}
    narrowed = narrow_tools_for_wind_down(
        available, allowed=["web_search", "handoff", "file_write", "file_list"]
    )
    assert "handoff" in narrowed
    assert "file_write" in narrowed
    assert "web_search" not in narrowed
    assert "code_execute" not in narrowed
    assert set(narrowed) <= (WIND_DOWN_ALLOWED_TOOLS | {"handoff"})
