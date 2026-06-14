"""Tests for convergence governance (runtime.loop_controller).

Pure logic — no LLM, no I/O. Covers the fingerprint, the three stuck patterns,
detection priority, and the two-strike NUDGE→FINALIZE ladder (including the
window clear that prevents a stale pattern from finalizing prematurely).
"""

from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    StuckReason,
    ToolAttempt,
    fingerprint_tool_call,
)


def _ok(fp: str, name: str = "t") -> ToolAttempt:
    return ToolAttempt(fingerprint=fp, tool_name=name, success=True)


def _fail(fp: str, name: str = "t") -> ToolAttempt:
    return ToolAttempt(fingerprint=fp, tool_name=name, success=False)


# --- fingerprint ---


def test_fingerprint_same_name_and_args_match():
    assert fingerprint_tool_call("web_search", '{"q": "x"}') == fingerprint_tool_call(
        "web_search", '{"q": "x"}'
    )


def test_fingerprint_ignores_key_order():
    assert fingerprint_tool_call("t", '{"a": 1, "b": 2}') == fingerprint_tool_call(
        "t", '{"b": 2, "a": 1}'
    )


def test_fingerprint_differs_on_args_and_name():
    assert fingerprint_tool_call("t", '{"q": "x"}') != fingerprint_tool_call(
        "t", '{"q": "y"}'
    )
    assert fingerprint_tool_call("a", "{}") != fingerprint_tool_call("b", "{}")


def test_fingerprint_malformed_json_falls_back_to_raw():
    # Identical malformed strings still collide (verbatim repeat caught);
    # different malformed strings do not.
    assert fingerprint_tool_call("t", "not json") == fingerprint_tool_call(
        "t", "not json"
    )
    assert fingerprint_tool_call("t", "not json") != fingerprint_tool_call(
        "t", "other junk"
    )


def test_fingerprint_empty_args_stable():
    assert fingerprint_tool_call("t", "") == fingerprint_tool_call("t", "")


# --- detect: nothing below threshold ---


def test_detect_below_threshold_returns_none():
    c = LoopController()
    c.record([_ok("a"), _ok("a")])  # 2 < threshold 3
    assert c.detect() is None


def test_detect_distinct_calls_returns_none():
    c = LoopController()
    c.record([_ok("a"), _ok("b"), _ok("c"), _ok("d")])
    assert c.detect() is None


# --- detect: repeated identical call ---


def test_detect_repeated_call():
    c = LoopController()
    c.record([_ok("a"), _ok("a"), _ok("a")])
    signal = c.detect()
    assert signal is not None
    assert signal.reason is StuckReason.REPEATED_CALL
    assert signal.count == 3


def test_detect_repeated_call_across_rounds():
    c = LoopController()
    c.record([_ok("a")])
    c.record([_ok("a")])
    assert c.detect() is None  # only 2 so far
    c.record([_ok("a")])
    assert c.detect().reason is StuckReason.REPEATED_CALL


def test_detect_three_identical_parallel_calls_in_one_round():
    c = LoopController()
    c.record([_ok("a"), _ok("a"), _ok("a")])
    assert c.detect().reason is StuckReason.REPEATED_CALL


# --- detect: repeated failure takes priority ---


def test_detect_repeated_failure_priority_over_repeated_call():
    c = LoopController()
    c.record([_fail("a"), _fail("a"), _fail("a")])
    signal = c.detect()
    assert signal.reason is StuckReason.REPEATED_FAILURE
    assert signal.count == 3


def test_detect_mixed_success_is_repeated_call_not_failure():
    c = LoopController()
    c.record([_ok("a"), _fail("a"), _ok("a")])  # only 2 failures < threshold
    assert c.detect().reason is StuckReason.REPEATED_CALL


# --- detect: A-B-A-B alternation ---


def test_detect_alternating():
    c = LoopController()
    c.record([_ok("a"), _ok("b"), _ok("a"), _ok("b")])
    signal = c.detect()
    assert signal is not None
    assert signal.reason is StuckReason.ALTERNATING


def test_detect_not_alternating_when_same_fingerprint():
    c = LoopController()
    # a,a,a,a → repeated_call wins, not alternation
    c.record([_ok("a"), _ok("a"), _ok("a"), _ok("a")])
    assert c.detect().reason is StuckReason.REPEATED_CALL


# --- decide: two-strike ladder ---


def test_decide_continue_when_no_signal():
    c = LoopController()
    assert c.decide(None) is Intervention.CONTINUE


def test_decide_first_signal_nudges_then_finalizes():
    c = LoopController()
    c.record([_ok("a"), _ok("a"), _ok("a")])
    first = c.detect()
    assert c.decide(first) is Intervention.NUDGE
    # window was cleared by the nudge: a fresh repeat is needed to escalate
    assert c.detect() is None
    c.record([_ok("a"), _ok("a"), _ok("a")])
    second = c.detect()
    assert c.decide(second) is Intervention.FINALIZE


def test_nudge_clears_window_so_one_stale_repeat_does_not_finalize():
    c = LoopController()
    c.record([_ok("a"), _ok("a"), _ok("a")])
    c.decide(c.detect())  # NUDGE + clear
    # Model recovers: a single different call must NOT immediately finalize.
    c.record([_ok("b")])
    assert c.detect() is None
