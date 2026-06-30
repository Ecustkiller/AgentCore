"""Unit tests for the offline 协作质量方向盘 (scripts/log_stats.py §2.5).

Pin the per-trace fold + the four MAST-labeled metrics it prints. ``scripts/`` is not
a package, so load the module by file path (no sys.path mutation)."""

import importlib.util
from collections import Counter
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "log_stats", Path(__file__).resolve().parents[1] / "scripts" / "log_stats.py"
)
log_stats = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(log_stats)


def test_accumulate_trace_folds_every_collab_signal():
    rec = log_stats._new_trace()
    for event, obj in [
        ("chat.turn_complete", {"delegated": True, "finish_reason": "end_turn"}),
        ("contract.retry", {}),
        ("revise.started", {}),
        ("delegate.started", {}),
        ("delegate.completed", {"escalations": 4, "scope": 1, "scope_ratio": 0.5}),
        ("delegate.yielded", {"reason": "scope"}),
        ("engine.loop_nudge", {}),
    ]:
        log_stats._accumulate_trace(rec, event, obj)

    assert rec["turn"] is True
    assert rec["delegated"] is True
    assert rec["finish_reason"] == "end_turn"
    assert rec["contract_retry"] == 1
    assert rec["revise"] == 1
    assert rec["delegate_batches"] == 1
    assert rec["escalations"] == 4
    assert rec["scope_boundaries"] == 1
    assert rec["scope_ratio_sum"] == 0.5 and rec["scope_ratio_n"] == 1
    assert rec["yields"] == 1 and rec["scope_yields"] == 1
    assert rec["loop_nudge"] == 1


def _line(out: str, needle: str) -> str:
    return next(ln for ln in out.splitlines() if needle in ln)


def test_collaboration_quality_metrics_over_traces(capsys):
    # Three turns: one clean delegated, one delegated that yielded (replan) + drifted + revised,
    # and one plain single-agent turn. Pin the four headline rates (spacing-robust).
    clean = log_stats._new_trace()
    for e, o in [("chat.turn_complete", {"delegated": True}), ("delegate.started", {})]:
        log_stats._accumulate_trace(clean, e, o)
    messy = log_stats._new_trace()
    for e, o in [
        ("chat.turn_complete", {"delegated": True}),
        ("delegate.started", {}),
        ("delegate.completed", {"escalations": 2, "scope": 0, "scope_ratio": 0.0}),
        ("delegate.yielded", {"reason": "scope"}),
        ("revise.started", {}),
    ]:
        log_stats._accumulate_trace(messy, e, o)
    plain = log_stats._new_trace()
    log_stats._accumulate_trace(plain, "chat.turn_complete", {"delegated": False})

    log_stats._print_collaboration_quality({"a": clean, "b": messy, "c": plain})
    out = capsys.readouterr().out

    assert "Turns 3  (delegated 2)" in out
    assert "50.0%" in _line(out, "首计划存活率")  # 1 of 2 delegated ran first plan clean
    assert "50.0%" in _line(out, "漂移率")  # 1 of 2 delegated turns drifted (scope)
    assert "33.3%" in _line(out, "返工率")  # 1 of 3 turns had a revise


def test_convergence_governance_splits_in_turn_vs_orphan(capsys):
    # A completed turn that nudged once, plus orphan events (an eval/test run, or a trace
    # whose turn never completed): the split must attribute in-turn vs orphan so the raw
    # totals reconcile with the turn-grouped 空转率 (no more silent gap).
    turn = log_stats._new_trace()
    for e, o in [("chat.turn_complete", {"delegated": False}), ("engine.loop_nudge", {})]:
        log_stats._accumulate_trace(turn, e, o)
    orphan = log_stats._new_trace()  # never logged chat.turn_complete
    log_stats._accumulate_trace(orphan, "engine.loop_nudge", {})
    log_stats._accumulate_trace(orphan, "engine.max_rounds_exhausted", {})

    events = Counter({"engine.loop_nudge": 2, "engine.max_rounds_exhausted": 1})
    log_stats._print_convergence_governance(events, {"a": turn, "b": orphan})
    out = capsys.readouterr().out

    assert "(1 in turns, 1 orphan)" in _line(out, "engine.loop_nudge")
    assert "(0 in turns, 1 orphan)" in _line(out, "engine.max_rounds_exhausted")


def test_convergence_governance_no_orphan_note_when_all_in_turn(capsys):
    # When every governance event belongs to a completed turn, no orphan note is shown
    # (the clean case — raw totals already equal the turn-grouped counts).
    turn = log_stats._new_trace()
    for e in ("chat.turn_complete", "engine.loop_finalize"):
        log_stats._accumulate_trace(turn, e, {})
    log_stats._print_convergence_governance(Counter({"engine.loop_finalize": 1}), {"a": turn})
    out = capsys.readouterr().out
    assert "engine.loop_finalize" in out
    assert "orphan" not in out


def test_collaboration_quality_silent_without_turns(capsys):
    # No completed turns in the window → no section printed (a trace with only sub-events
    # but no chat.turn_complete is an incomplete/rotated trace, correctly excluded).
    orphan = log_stats._new_trace()
    log_stats._accumulate_trace(orphan, "engine.max_rounds_exhausted", {})
    log_stats._print_collaboration_quality({"x": orphan})
    assert capsys.readouterr().out == ""
