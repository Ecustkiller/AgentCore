"""CLI 棘轮回归门（``python -m agentcore.evals --baseline``）的接线单测.

审计 EVAL-A2：棘轮实现完整却从没被自动化调用过。夜跑现在把 ``--baseline`` 挂在既有真跑上，
并靠报告 JSON 里的 ``ratchet`` 段把判定喂给作业摘要——本文件钉住这条接线：判定写没写、
写得对不对、退出码有没有跟着变；顺带钉 ``--update-baseline`` 与 ``--out`` 同给仍两边都落盘。

零 LLM：``run_suite`` 与 ``load_cases`` 都打桩，只验 CLI 的 baseline 分支。
"""

from __future__ import annotations

import json
from pathlib import Path

from agentcore.evals.__main__ import main
from agentcore.evals.types import CaseReport, EvalCase, EvalReport, TurnOutcome


def _case(idx: int, *, passed: bool) -> CaseReport:
    # error 非空即判负——最省事的造负样本方式（判定口径见 CaseReport.passed）。
    outcome = TurnOutcome(
        content="ok", finish_reason="end_turn", rounds=1, error=None if passed else "boom"
    )
    return CaseReport(case_id=f"c{idx}", category="qa", outcome=outcome)


def _stub_suite(monkeypatch, *, passed: int, total: int) -> None:
    cases = [_case(i, passed=i < passed) for i in range(total)]
    report = EvalReport(cases=cases)

    async def _fake_run_suite(*_args, **_kwargs):
        return report

    monkeypatch.setattr(
        "agentcore.evals.__main__.load_cases",
        lambda *_a, **_k: [EvalCase(id="c0", category="qa", user_message="hi", rubric="r")],
    )
    monkeypatch.setattr("agentcore.evals.__main__.run_suite", _fake_run_suite)


def _write_baseline(path: Path, pass_rate: float) -> None:
    path.write_text(
        json.dumps({"summary": {"total": 10, "passed": 9, "pass_rate": pass_rate}}),
        encoding="utf-8",
    )


def test_regression_marks_ratchet_and_reds_exit_code(tmp_path: Path, monkeypatch):
    baseline = tmp_path / "core-baseline.json"
    _write_baseline(baseline, 0.9)
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=5, total=10)

    code = main(["--suite", "core", "--layer", "1", "--baseline", str(baseline), "--out", str(out)])

    assert code == 1
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["available"] is True
    assert ratchet["regressed"] is True
    assert ratchet["pass_rate"] == 0.5
    assert ratchet["baseline_pass_rate"] == 0.9
    assert ratchet["tolerance"] == 0.05


def test_within_tolerance_is_not_a_regression(tmp_path: Path, monkeypatch):
    """真模型天然抖动：跌幅在容差内不算回归，退出码只反映用例本身。"""
    baseline = tmp_path / "core-baseline.json"
    _write_baseline(baseline, 1.0)
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    code = main(
        [
            "--suite",
            "core",
            "--layer",
            "1",
            "--baseline",
            str(baseline),
            "--regression-tolerance",
            "0.2",
            "--out",
            str(out),
        ]
    )

    assert code == 0
    assert json.loads(out.read_text(encoding="utf-8"))["ratchet"]["regressed"] is False


def test_missing_baseline_is_recorded_as_unavailable(tmp_path: Path, monkeypatch):
    """首跑没有基线：报告要写明「无基线可比」，而不是留白让人误读成通过。"""
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    code = main(
        [
            "--suite",
            "core",
            "--layer",
            "1",
            "--baseline",
            str(tmp_path / "nope.json"),
            "--out",
            str(out),
        ]
    )

    assert code == 0
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["available"] is False
    assert ratchet["pass_rate"] == 1.0


def test_no_baseline_flag_leaves_report_clean(tmp_path: Path, monkeypatch):
    """没要求跑棘轮就不该凭空多出 ratchet 段（摘要据其有无判断「棘轮接没接」）。"""
    out = tmp_path / "probe.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    assert main(["--suite", "probe", "--layer", "1", "--out", str(out)]) == 0
    assert "ratchet" not in json.loads(out.read_text(encoding="utf-8"))


def test_update_baseline_writes_both_baseline_and_report(tmp_path: Path, monkeypatch):
    baseline = tmp_path / "core-baseline.json"
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=8, total=10)

    code = main(
        [
            "--suite",
            "core",
            "--layer",
            "1",
            "--baseline",
            str(baseline),
            "--update-baseline",
            "--out",
            str(out),
        ]
    )

    assert code == 0
    assert json.loads(baseline.read_text(encoding="utf-8"))["summary"]["pass_rate"] == 0.8
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["summary"]["pass_rate"] == 0.8
    # 落基线时不跑回归门（拿自己比自己没意义）。
    assert "ratchet" not in written
