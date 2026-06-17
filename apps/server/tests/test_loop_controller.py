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
    progress_review_prompt,
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


# --- B2: empty-response degraded ladder ---


def test_empty_response_first_empty_falls_back_then_finalizes():
    # The default ladder: 1st empty → FALLBACK (retry on the stronger model), and a
    # 2nd consecutive empty → FINALIZE (the turn ends degraded, not blank).
    c = LoopController(empty_threshold=2)
    c.note_empty_round(True)
    assert c.empty_response_action(fallback_available=True) is Intervention.FALLBACK
    c.note_empty_round(True)
    # fallback already spent → the streak hits threshold → finalize
    assert c.empty_response_action(fallback_available=False) is Intervention.FINALIZE


def test_empty_response_without_fallback_continues_then_finalizes():
    # No fallback model: the 1st empty just retries as-is (CONTINUE), the 2nd finalizes.
    c = LoopController(empty_threshold=2)
    c.note_empty_round(True)
    assert c.empty_response_action(fallback_available=False) is Intervention.CONTINUE
    c.note_empty_round(True)
    assert c.empty_response_action(fallback_available=False) is Intervention.FINALIZE


def test_empty_response_fallback_used_at_most_once():
    # The fallback latch: once escalated, a later empty does not FALLBACK again.
    c = LoopController(empty_threshold=3)
    c.note_empty_round(True)
    assert c.empty_response_action(fallback_available=True) is Intervention.FALLBACK
    c.note_empty_round(True)
    # still below threshold (3) but fallback is spent → CONTINUE, not FALLBACK
    assert c.empty_response_action(fallback_available=True) is Intervention.CONTINUE


def test_empty_streak_resets_on_nonempty_round():
    # A real answer / tool call between empties breaks the streak, so only
    # *consecutive* empties escalate.
    c = LoopController(empty_threshold=2)
    c.note_empty_round(True)
    c.note_empty_round(False)  # recovered
    c.note_empty_round(True)  # streak restarts at 1
    assert c.empty_response_action(fallback_available=False) is Intervention.CONTINUE


# --- B2: tool failure circuit breaker ---


def test_circuit_breaker_warns_at_warn_threshold():
    c = LoopController(tool_failure_warn=2, tool_failure_disable=3)
    c.record([_fail("a", "t")])  # 1 failure (distinct args, same tool)
    assert not c.tool_circuit_breaker()  # below warn
    c.record([_fail("b", "t")])  # 2 failures
    cb = c.tool_circuit_breaker()
    assert cb.warned == ("t",)
    assert cb.disabled == ()


def test_circuit_breaker_disables_at_disable_threshold_and_is_idempotent():
    c = LoopController(tool_failure_warn=2, tool_failure_disable=3)
    c.record([_fail("a", "t"), _fail("b", "t")])
    assert c.tool_circuit_breaker().warned == ("t",)
    c.record([_fail("c", "t")])  # 3rd failure
    cb = c.tool_circuit_breaker()
    assert cb.disabled == ("t",)
    assert cb.warned == ()  # not re-warned
    # already disabled → no further transitions fire for this tool
    c.record([_fail("d", "t")])
    assert not c.tool_circuit_breaker()


def test_circuit_breaker_leaps_straight_to_disable_without_redundant_warn():
    # 3 failures arrive before any check → the tool is disabled outright (no warn).
    c = LoopController(tool_failure_warn=2, tool_failure_disable=3)
    c.record([_fail("a", "t"), _fail("b", "t"), _fail("c", "t")])
    cb = c.tool_circuit_breaker()
    assert cb.disabled == ("t",)
    assert cb.warned == ()


def test_circuit_breaker_counts_failures_per_tool_and_ignores_success():
    c = LoopController(tool_failure_warn=2, tool_failure_disable=3)
    c.record([_ok("a", "t"), _ok("b", "t")])  # successes never count
    c.record([_fail("c", "u")])  # a different tool's single failure
    assert not c.tool_circuit_breaker()


def test_circuit_breaker_tally_survives_nudge_window_clear():
    # The cumulative per-tool tally is run-scoped: the nudge's sliding-window reset
    # must NOT reset it (otherwise a tool failing across a nudge would never trip).
    c = LoopController(tool_failure_warn=2, tool_failure_disable=3)
    c.record([_fail("a", "t"), _fail("a", "t"), _fail("a", "t")])  # 3 failures
    assert c.decide(c.detect()) is Intervention.NUDGE  # clears the window
    cb = c.tool_circuit_breaker()
    assert cb.disabled == ("t",)


# --- B2: no-output early stop (unproductive rounds) ---


def _unproductive(c: LoopController) -> None:
    c.note_round_productivity(had_tool_calls=True, all_failed=True, had_content=False)


def test_unproductive_streak_trips_after_threshold():
    c = LoopController(unproductive_threshold=3)
    _unproductive(c)
    assert not c.unproductive_early_stop()
    _unproductive(c)
    assert not c.unproductive_early_stop()
    _unproductive(c)
    assert c.unproductive_early_stop()


def test_unproductive_streak_resets_on_content():
    c = LoopController(unproductive_threshold=2)
    _unproductive(c)
    # content this round (even with a failing tool) is progress → resets
    c.note_round_productivity(had_tool_calls=True, all_failed=True, had_content=True)
    _unproductive(c)
    assert not c.unproductive_early_stop()  # streak restarted at 1


def test_unproductive_streak_resets_on_tool_success():
    c = LoopController(unproductive_threshold=2)
    _unproductive(c)
    # a tool succeeded → not all-failed → resets
    c.note_round_productivity(had_tool_calls=True, all_failed=False, had_content=False)
    _unproductive(c)
    assert not c.unproductive_early_stop()


def test_no_tool_round_is_not_unproductive():
    # A no-tool round is the empty/degraded path, not the unproductive one.
    c = LoopController(unproductive_threshold=1)
    c.note_round_productivity(had_tool_calls=False, all_failed=False, had_content=False)
    assert not c.unproductive_early_stop()


# --- B2: periodic reflection injection ---


def test_reflection_due_fires_on_cadence():
    c = LoopController(reflection_start_round=3, reflection_interval=3)
    # 4th / 7th / 10th round (0-indexed 3 / 6 / 9)
    assert [r for r in range(11) if c.reflection_due(r)] == [3, 6, 9]


def test_reflection_not_due_before_start_round():
    c = LoopController(reflection_start_round=3, reflection_interval=3)
    assert not any(c.reflection_due(r) for r in range(3))


def test_reflection_cadence_is_configurable():
    c = LoopController(reflection_start_round=2, reflection_interval=4)
    assert [r for r in range(11) if c.reflection_due(r)] == [2, 6, 10]


def test_progress_review_prompt_is_anchored_to_round():
    msg = progress_review_prompt(4)
    assert "进度复盘" in msg
    assert "已进行 4 轮" in msg
