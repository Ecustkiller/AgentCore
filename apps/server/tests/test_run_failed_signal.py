"""run_failed payload + sink terminal idempotency + error-signal projection."""

from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import (
    RETRY_AFTER_FROM_HEADER,
    LLMError,
    LLMRateLimitError,
    mark_llm_leaf_exhausted,
)
from agentcore.runtime.events import EventSink, EventType, run_completed, run_failed
from agentcore.runtime.runs.error_signal import run_error_signal


def test_run_error_signal_reads_rate_limit_fields():
    unattested = LLMRateLimitError(retry_after=4.0)
    signal = run_error_signal(unattested)
    assert signal.error_code == ErrorCode.LLM_RATE_LIMIT
    assert signal.retryable is True
    # 引擎握着秒数；未 attested 不上 run_failed.retry_after。
    assert unattested.retry_after == 4.0
    assert signal.retry_after is None

    attested = LLMRateLimitError(
        retry_after=4.0, retry_after_source=RETRY_AFTER_FROM_HEADER
    )
    assert run_error_signal(attested).retry_after == 4.0


def test_run_error_signal_exhausted_rate_limit_stays_transient():
    """叶层用尽就地重试后 ``exc.retryable`` 为 False，但限流仍是瞬时。"""
    exc = LLMRateLimitError(retry_after=4.0)
    mark_llm_leaf_exhausted(exc)
    assert exc.retryable is False
    signal = run_error_signal(exc)
    assert signal.error_code == ErrorCode.LLM_RATE_LIMIT
    assert signal.retryable is True
    assert signal.retry_after is None


def test_run_error_signal_unknown_crash_is_terminal():
    signal = run_error_signal(RuntimeError("provider down"))
    assert signal.error_code is None
    assert signal.retryable is False
    assert signal.retry_after is None


def test_run_error_signal_deterministic_llm_error():
    signal = run_error_signal(LLMError("上下文超长（400）"))
    assert signal.error_code == ErrorCode.LLM_ERROR
    assert signal.retryable is False


def test_run_failed_payload_omits_absent_signal_fields():
    event = run_failed("r1", "a1", "boom")
    assert event.payload == {"run_id": "r1", "agent_id": "a1", "error": "boom"}


def test_run_failed_payload_carries_error_signal():
    event = run_failed(
        "r1",
        "a1",
        "限流",
        failure_kind="call",
        error_code=ErrorCode.LLM_RATE_LIMIT,
        retryable=True,
        retry_after=4.0,
    )
    assert event.payload["error_code"] == ErrorCode.LLM_RATE_LIMIT
    assert event.payload["retryable"] is True
    assert event.payload["retry_after"] == 4.0


def test_sink_drops_duplicate_run_terminal():
    sink = EventSink()
    first = run_failed("w1", "w1", "first", retryable=True)
    second = run_failed("w1", "w1", "second", retryable=False)
    later_complete = run_completed(
        "w1",
        "w1",
        output_summary="",
        duration_ms=1,
        role="member",
        model="",
        usage={"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0},
        cost={"input": 0, "cached": 0, "output": 0, "total": 0},
    )
    assert sink.emit(first) is False  # no live subscriber, but accepted
    assert sink.emit(second) is False
    assert sink.emit(later_complete) is False
    kinds = [e.type for e in sink._history]
    assert kinds.count(EventType.RUN_FAILED) == 1
    assert EventType.RUN_COMPLETED not in kinds
    assert sink._history[0].payload["error"] == "first"
