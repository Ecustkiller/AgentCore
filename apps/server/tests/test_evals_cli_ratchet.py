"""CLI 相对基线观测（``python -m agentcore.evals run … --baseline``）的接线单测.

本文件钉：观测写没写、翻转签名对不对、**退出码不跟观测走**（只跟用例自身 pass/fail）。

零 LLM：``run_suite`` 打桩；``run routing`` 另打桩 playbook 真跑。
"""

from __future__ import annotations

import json
from pathlib import Path

from agentcore.evals.cli import main
from agentcore.evals.types import CaseReport, EvalReport, TurnOutcome


def _case(idx: int, *, passed: bool) -> CaseReport:
    outcome = TurnOutcome(
        content="ok", finish_reason="end_turn", rounds=1, error=None if passed else "boom"
    )
    return CaseReport(case_id=f"c{idx}", category="qa", outcome=outcome)


def _stub_suite(monkeypatch, *, passed: int, total: int) -> None:
    cases = [_case(i, passed=i < passed) for i in range(total)]
    report = EvalReport(cases=cases)

    async def _fake_run_suite(*_args, **_kwargs):
        return report

    monkeypatch.setattr("agentcore.evals.cli.run_suite", _fake_run_suite)


def _stub_playbook(monkeypatch) -> None:
    async def _fake(**_kwargs):
        return {
            "ok": True,
            "gate": False,
            "meta": {"model": "fake", "samples": 1, "tokens": {}, "cost_note": ""},
            "scenarios": [],
            "diff": {"available": False, "changed": []},
        }

    monkeypatch.setattr(
        "agentcore.evals.playbook_routing_loop.run_playbook_routing", _fake
    )


def _write_baseline(path: Path, *, passed: int, total: int) -> None:
    cases = [
        {"case_id": f"c{i}", "category": "qa", "passed": i < passed} for i in range(total)
    ]
    path.write_text(
        json.dumps(
            {
                "summary": {
                    "total": total,
                    "passed": passed,
                    "pass_rate": passed / total if total else 0.0,
                },
                "cases": cases,
            }
        ),
        encoding="utf-8",
    )


def test_directional_drop_is_observed_but_exit_follows_cases(
    tmp_path: Path, monkeypatch
):
    """5/10 对 9/10：签名是单方向变差；退出码 1 是因为用例没全过，不是观测门。"""
    baseline = tmp_path / "core-baseline.json"
    _write_baseline(baseline, passed=9, total=10)
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=5, total=10)

    code = main(
        [
            "run",
            "core",
            "--checks",
            "--baseline",
            str(baseline),
            "--out",
            str(out),
        ]
    )

    assert code == 1  # 用例未全过
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["available"] is True
    assert ratchet["gate"] is False
    assert ratchet["signature"] == "directional_drop"
    assert ratchet["can_separate_variance"] is True
    assert "tolerance" not in ratchet
    assert "regressed" not in ratchet


def test_all_pass_with_baseline_stays_green(tmp_path: Path, monkeypatch):
    """观测不额外弄红：自身全过时退出码仍为 0。"""
    baseline = tmp_path / "core-baseline.json"
    _write_baseline(baseline, passed=10, total=10)
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    code = main(
        [
            "run",
            "core",
            "--checks",
            "--baseline",
            str(baseline),
            "--out",
            str(out),
        ]
    )

    assert code == 0
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["signature"] == "unchanged"
    assert ratchet["gate"] is False


def test_missing_baseline_is_recorded_as_unavailable(tmp_path: Path, monkeypatch):
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    code = main(
        [
            "run",
            "core",
            "--checks",
            "--baseline",
            str(tmp_path / "nope.json"),
            "--out",
            str(out),
        ]
    )

    assert code == 0
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["available"] is False
    assert ratchet["signature"] == "no_baseline"
    assert ratchet["pass_rate"] == 1.0


def test_no_baseline_flag_leaves_report_clean(tmp_path: Path, monkeypatch):
    out = tmp_path / "probe.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    assert main(["run", "probe", "--checks", "--out", str(out)]) == 0
    assert "ratchet" not in json.loads(out.read_text(encoding="utf-8"))


def test_update_baseline_writes_both_baseline_and_report(tmp_path: Path, monkeypatch):
    baseline = tmp_path / "core-baseline.json"
    out = tmp_path / "functional.json"
    _stub_suite(monkeypatch, passed=8, total=10)

    code = main(
        [
            "run",
            "core",
            "--checks",
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
    assert "ratchet" not in written


def test_observe_is_zero_llm_and_never_reds(tmp_path: Path):
    current = tmp_path / "now.json"
    baseline = tmp_path / "base.json"
    out = tmp_path / "obs.json"
    ids = [f"c{i}" for i in range(4)]
    current.write_text(
        json.dumps(
            {
                "summary": {"total": 4, "passed": 2, "pass_rate": 0.5},
                "cases": [
                    {"case_id": cid, "passed": i < 2, "category": "qa"}
                    for i, cid in enumerate(ids)
                ],
            }
        ),
        encoding="utf-8",
    )
    baseline.write_text(
        json.dumps(
            {
                "summary": {"total": 4, "passed": 4, "pass_rate": 1.0},
                "cases": [{"case_id": cid, "passed": True, "category": "qa"} for cid in ids],
            }
        ),
        encoding="utf-8",
    )

    code = main(["observe", str(current), str(baseline), "--out", str(out)])

    assert code == 0
    obs = json.loads(out.read_text(encoding="utf-8"))
    assert obs["signature"] == "directional_drop"
    assert obs["gate"] is False


def test_probe_baseline_observes_without_redding(tmp_path: Path, monkeypatch):
    baseline = tmp_path / "probe-latest.json"
    _write_baseline(baseline, passed=10, total=10)
    out = tmp_path / "probe.json"
    _stub_suite(monkeypatch, passed=10, total=10)

    code = main(
        ["run", "probe", "--checks", "--baseline", str(baseline), "--out", str(out)]
    )

    assert code == 0
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["kind"] == "suite"
    assert ratchet["gate"] is False
    assert ratchet["signature"] == "unchanged"


def test_routing_baseline_observes_without_redding(tmp_path: Path, monkeypatch):
    from agentcore.evals.routing import RoutingMetrics

    _stub_suite(monkeypatch, passed=10, total=10)
    _stub_playbook(monkeypatch)
    monkeypatch.setattr(
        "agentcore.evals.cli.routing_metrics",
        lambda *_a, **_k: RoutingMetrics(
            total=4, tp=2, tn=1, fp=0, fn=1, misroutes=[("c3", True, False)]
        ),
    )
    baseline = tmp_path / "routing-latest.json"
    baseline.write_text(
        json.dumps({"routing": {"total": 4, "accuracy": 1.0, "misroutes": []}}),
        encoding="utf-8",
    )
    out = tmp_path / "routing.json"

    code = main(["run", "routing", "--baseline", str(baseline), "--out", str(out)])

    assert code == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert "delegate" in payload and "playbook" in payload
    ratchet = payload["delegate"]["ratchet"]
    assert ratchet["kind"] == "routing"
    assert ratchet["gate"] is False
    assert ratchet["signature"] == "directional_drop"


def test_style_is_plugin_on_same_run(tmp_path: Path, monkeypatch):
    from agentcore.evals.style_lint import StyleMetrics

    _stub_suite(monkeypatch, passed=10, total=10)
    monkeypatch.setattr(
        "agentcore.evals.cli.style_metrics",
        lambda *_a, **_k: StyleMetrics(total=4, clean=3, offenders=[("c3", ["opening"])]),
    )
    out = tmp_path / "core.json"

    code = main(["run", "core", "--checks", "--style", "--out", str(out)])

    assert code == 0
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["style"]["clean_rate"] == 0.75
    assert "ratchet" not in payload


def test_compare_baseline_observes_without_redding(tmp_path: Path, monkeypatch):
    from agentcore.evals.types import ComparisonReport

    async def _fake(*_a, **_k):
        return ComparisonReport(cases=[])

    monkeypatch.setattr("agentcore.evals.cli.load_comparison_cases", lambda *_a, **_k: [])
    monkeypatch.setattr("agentcore.evals.cli.run_comparison_suite", _fake)
    monkeypatch.setattr(
        "agentcore.evals.cli.build_default_pairwise_judge", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(
        "agentcore.evals.cli.comparison_report_to_dict",
        lambda *_a, **_k: {
            "summary": {
                "total_cases": 1,
                "by_archetype": {"simple": {"avg_win_rate": 0.2}},
            },
            "cases": [
                {"case_id": "t1", "comparisons": {"team": {"win_rate": 0.2}}},
            ],
        },
    )
    baseline = tmp_path / "comparison-latest.json"
    baseline.write_text(
        json.dumps(
            {
                "summary": {
                    "total_cases": 1,
                    "by_archetype": {"simple": {"avg_win_rate": 0.8}},
                },
                "cases": [
                    {"case_id": "t1", "comparisons": {"team": {"win_rate": 0.8}}},
                ],
            }
        ),
        encoding="utf-8",
    )
    out = tmp_path / "comparison.json"

    code = main(["run", "compare", "--baseline", str(baseline), "--out", str(out)])

    assert code == 0
    ratchet = json.loads(out.read_text(encoding="utf-8"))["ratchet"]
    assert ratchet["kind"] == "comparison"
    assert ratchet["gate"] is False
    assert ratchet["signature"] == "directional_drop"


def test_lint_routing_covers_playbook_and_cases():
    assert main(["lint", "--suite", "routing"]) == 0


def test_lint_all_zero_llm():
    assert main(["lint"]) == 0
