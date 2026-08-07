"""Soft-fail settle: error SSE must land on turn_end + settle result."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agentcore.core.error_codes import ErrorCode
from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.events import EventSink, FinishReason, error_event
from agentcore.runtime.pipeline.finalize import _journal_entries_for_turn
from agentcore.runtime.pipeline.resume.finish import finish_resume_turn
from agentcore.runtime.pipeline.settle import (
    salvage_pipeline_exception,
    settle_successful_turn,
)
from tests.llm_helpers import make_profile_params


@pytest.mark.asyncio
async def test_settle_soft_fail_persists_error_on_result_and_journal():
    sink = EventSink()
    sink.emit(
        error_event(
            ErrorCode.LLM_TIMEOUT,
            "连接 byok 超时，请检查网络后重试",
        )
    )

    captain_state = SimpleNamespace(
        content="",
        reasoning="",
        rounds=1,
        usage=TokenUsage().as_dict(),
        cost={"total": 0, "currency": "USD"},
        model="deepseek-v4-flash",
        duration_ms=0,
        finish_override=FinishReason.ERROR,
    )
    delegate = SimpleNamespace(
        usage={},
        run_ledger=[],
        citations=[],
        collab={"boundary_yields": 0, "scope_signals": 0, "escalations": 0},
        continuation_count=0,
        dispose_open_supervised=AsyncMock(),
    )
    debate = SimpleNamespace(usage={}, run_ledger=[], citations=[])
    profile = SimpleNamespace(max_rounds=20)
    audit = SimpleNamespace(drops=0, flush=AsyncMock())
    journal_writer = SimpleNamespace(flush=AsyncMock())

    result = await settle_successful_turn(
        message_id="m1",
        captain_run_id="cap",
        captain_state=captain_state,
        delegate_tool=delegate,
        debate_tool=debate,
        profile=profile,
        citations=[],
        vision_cost_sink=[],
        sink=sink,
        fact_log=None,
        audit_recorder=audit,
        roster_writer=None,
        journal_writer=journal_writer,
    )

    assert result["finish_reason"] is FinishReason.ERROR
    assert result["error_code"] == ErrorCode.LLM_TIMEOUT
    assert "超时" in result["error"]
    entries = result["journal_entries"]
    assert entries is not None
    turn_end = next(e for e in entries if e["kind"] == "turn_end")
    assert turn_end["payload"]["finish_reason"] == "error"
    assert turn_end["payload"]["error"]["code"] == ErrorCode.LLM_TIMEOUT


@pytest.mark.asyncio
async def test_finish_resume_soft_fail_stamps_last_turn_error():
    """L1 方案 2：resume finish → settle 同核，soft-fail last_turn_error 须上结果。"""
    sink = EventSink()
    sink.emit(error_event(ErrorCode.LLM_TIMEOUT, "resume soft-fail 超时"))

    captain_state = SimpleNamespace(
        content="续跑正文",
        reasoning="",
        rounds=1,
        usage=TokenUsage().as_dict(),
        cost={"total": 0, "currency": "USD"},
        model="m",
        duration_ms=0,
        finish_override=FinishReason.ERROR,
    )
    result = await finish_resume_turn(
        message_id="m-resume",
        captain_run_id="cap",
        captain_state=captain_state,
        pre_pause_content="挂起前",
        delegate_tool=SimpleNamespace(
            usage={},
            run_ledger=[],
            citations=[],
            collab={},
            continuation_count=0,
            dispose_open_supervised=AsyncMock(),
        ),
        debate_tool=SimpleNamespace(usage={}, run_ledger=[], citations=[]),
        profile=make_profile_params(max_rounds=20),
        citations=[],
        sink=sink,
        fact_log=None,
        audit_recorder=SimpleNamespace(drops=0, flush=AsyncMock()),
        roster_writer=None,
        journal_writer=SimpleNamespace(flush=AsyncMock()),
    )
    assert result["error_code"] == ErrorCode.LLM_TIMEOUT
    assert "超时" in result["error"]
    assert "挂起前" in result["content"]
    assert "续跑正文" in result["content"]


@pytest.mark.asyncio
async def test_salvage_pipeline_exception_carries_journal_entries():
    """Exception salvage must assemble journal (resume path reuses this kernel)."""
    sink = EventSink()
    sink._process.append({"kind": "reasoning", "text": "partial"})
    audit = SimpleNamespace(drops=0, flush=AsyncMock())

    result = await salvage_pipeline_exception(
        e=RuntimeError("boom mid-resume"),
        message_id="m1",
        sink=sink,
        fact_log=None,
        audit_recorder=audit,
        roster_writer=None,
    )
    assert result["finish_reason"] is FinishReason.ERROR
    assert result["error_code"] == ErrorCode.PIPELINE_ERROR
    assert result["journal_entries"] is not None
    turn_end = next(e for e in result["journal_entries"] if e["kind"] == "turn_end")
    assert turn_end["payload"]["finish_reason"] == "error"


def test_journal_entries_include_error_when_process_present():
    sink = EventSink()
    # Simulate a process step so the journal gate opens for reasons other than error.
    sink._process.append({"kind": "reasoning", "text": "…" })
    sink.emit(error_event(ErrorCode.LLM_KEY_INVALID, "Key 无效"))

    entries = _journal_entries_for_turn(None, sink=sink, finish=FinishReason.ERROR)
    assert entries is not None
    turn_end = next(e for e in entries if e["kind"] == "turn_end")
    assert turn_end["payload"]["error"]["code"] == ErrorCode.LLM_KEY_INVALID
