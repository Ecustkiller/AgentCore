"""夜跑评测作业摘要（scripts/eval_nightly_summary.py）的诚实性单测.

守的就是审计要治的病：**「没考」不许长得像「考了全过」**。三条路径各钉一遍——
无 key 全跳过 / 有 key 全绿 / 有 key 但降级（跑挂 · 未通过 · 报告缺失），再钉
「摘要恒 0 退出」（软门禁的红绿判定权仍在 workflow，摘要不许改）。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from scripts.eval_nightly_summary import STEPS, load_rows, main, render

_ALL_IDS = tuple(s.step_id for s in STEPS)


def _steps(**outcomes: str) -> dict[str, Any]:
    """构造 workflow ``toJSON(steps)`` 形状；未点名的步骤按 skipped。"""
    return {sid: {"outcome": outcomes.get(sid, "skipped")} for sid in _ALL_IDS}


def _suite_report(pass_rate: float = 1.0, ratchet: dict | None = None) -> dict:
    total = 10
    passed = int(round(total * pass_rate))
    report: dict[str, Any] = {
        "summary": {
            "total": total,
            "passed": passed,
            "pass_rate": pass_rate,
            "cost_usd": 0.1234,
            "by_mast": {"by_group": {"FC1": {"total": 4, "passed": 3, "pass_rate": 0.75}}},
        },
        "cases": [],
    }
    if ratchet is not None:
        report["ratchet"] = ratchet
    return report


def _write(reports: Path, name: str, payload: dict) -> None:
    reports.mkdir(parents=True, exist_ok=True)
    (reports / name).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _full_green(reports: Path) -> None:
    """八个步骤全部出数、全部通过的报告集。"""
    ok_ratchet = {
        "available": True,
        "baseline_pass_rate": 0.95,
        "pass_rate": 1.0,
        "tolerance": 0.05,
        "regressed": False,
    }
    _write(reports, "functional.json", _suite_report(ratchet=ok_ratchet))
    _write(reports, "mast.json", _suite_report(ratchet=ok_ratchet))
    _write(reports, "routing.json", {"routing": {"accuracy": 0.9, "total": 10}})
    _write(reports, "style.json", {"total": 12, "clean_rate": 0.92})
    _write(
        reports,
        "comparison.json",
        {"summary": {"total_cases": 4, "by_archetype": {"simple": {"avg_win_rate": 0.6}}}},
    )
    _write(
        reports,
        "calibration.json",
        {"n": 34, "cohens_kappa": 0.72, "kappa_gate": 0.6, "mean_bias": 0.3, "trustworthy": True},
    )
    _write(reports, "probe.json", _suite_report())
    _write(reports, "probe_code.json", {"summary": {"total": 8, "passed": 8, "pass_rate": 1.0}})


# --- 无 key：必须显式说「本次未覆盖」 ----------------------------------------


def test_no_key_summary_says_not_covered(tmp_path: Path):
    rows = load_rows(tmp_path / "eval-reports", _steps())
    md, annotation = render(rows, suite="core", key_present=False)

    assert "AI 行为面：本次未覆盖" in md
    assert "EVAL_DEEPSEEK_API_KEY" in md
    # 每个真跑步骤都必须逐条写明未执行，不许静默略过。
    assert md.count("| 未执行 | 本次未考 |") == len(STEPS)
    for spec in STEPS:
        assert spec.title in md
    assert annotation.startswith("::warning::")
    assert "未覆盖" in annotation
    # 校准没跑就得说裁判没校准，别让 pass_rate 看着像有刻度。
    assert "裁判校准未执行" in md


def test_no_key_summary_never_claims_pass(tmp_path: Path):
    rows = load_rows(tmp_path / "eval-reports", _steps())
    md, _ = render(rows, suite="core", key_present=False)
    assert "全部通过" not in md
    assert "::notice::" not in md


# --- 有 key 全绿：一眼看出考了什么 -------------------------------------------


def test_all_green_summary_shows_what_was_covered(tmp_path: Path):
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    rows = load_rows(reports, _steps(**{sid: "success" for sid in _ALL_IDS}))
    md, annotation = render(rows, suite="core", key_present=True)

    assert "AI 行为面：已覆盖，全部通过" in md
    assert annotation.startswith("::notice::")
    assert "未执行" not in md
    # 关键指标真渲染出来了（而不是空格子）。
    assert "通过 10/10（100%）" in md
    assert "准确率 90%" in md
    assert "干净率 92%" in md
    assert "Cohen's kappa 0.720（门 0.60）→ 裁判可信" in md
    # 棘轮判定 + MAST 分组明细。
    assert "棘轮：1.0000 vs 基线 0.9500（容差 0.05）→ 未回归" in md
    assert "FC1 3/4（75%）" in md
    # 软门禁语义仍要写明：绿灯不等于没回归。
    assert "软门禁" in md


def test_ratchet_regression_is_spelled_out(tmp_path: Path):
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    _write(
        reports,
        "functional.json",
        _suite_report(
            pass_rate=0.7,
            ratchet={
                "available": True,
                "baseline_pass_rate": 0.95,
                "pass_rate": 0.7,
                "tolerance": 0.05,
                "regressed": True,
            },
        ),
    )
    outcomes = dict.fromkeys(_ALL_IDS, "success")
    outcomes["functional"] = "failure"
    rows = load_rows(reports, _steps(**outcomes))
    md, annotation = render(rows, suite="core", key_present=True)

    assert "→ 回归" in md
    assert "已跑·未通过" in md
    # 全部出了数 = 考过了；考过了不等于过了，标题得把两件事分开说。
    assert "已覆盖，1 项未通过" in md
    assert "1 项未通过" in annotation


def test_missing_ratchet_block_is_flagged(tmp_path: Path):
    """棘轮没接上（报告里没有 ratchet 段）要喊出来，不能默默当没这道门。"""
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    _write(reports, "functional.json", _suite_report())
    rows = load_rows(reports, _steps(**{sid: "success" for sid in _ALL_IDS}))
    md, _ = render(rows, suite="core", key_present=True)
    assert "棘轮：未接（应有而无）" in md


def test_first_run_without_baseline_is_explicit(tmp_path: Path):
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    _write(
        reports,
        "functional.json",
        _suite_report(ratchet={"available": False, "pass_rate": 1.0}),
    )
    rows = load_rows(reports, _steps(**{sid: "success" for sid in _ALL_IDS}))
    md, _ = render(rows, suite="core", key_present=True)
    assert "棘轮：无基线可比" in md


# --- 有 key 但降级：跑挂 / 未通过 / 缺报告都要写出来 -------------------------


def test_degraded_run_reports_each_failure_mode(tmp_path: Path):
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    # 跑挂：步骤 failure 且没落下报告。
    (reports / "probe_code.json").unlink()
    # 校准整个没执行。
    (reports / "calibration.json").unlink()
    outcomes = dict.fromkeys(_ALL_IDS, "success")
    outcomes["probe_code"] = "failure"
    outcomes["mast"] = "failure"
    outcomes["calibrate"] = "skipped"
    rows = load_rows(reports, _steps(**outcomes))
    md, annotation = render(rows, suite="core", key_present=True)

    assert "部分覆盖（6/8 项出数）" in md
    assert "跑挂·未出数" in md
    assert "步骤未产出报告 JSON" in md
    assert "MAST 失败标签套件（含棘轮回归门）" in md
    assert "裁判校准未执行" in md
    assert annotation.startswith("::warning::")


def test_key_present_but_nothing_produced_is_not_covered(tmp_path: Path):
    outcomes = dict.fromkeys(_ALL_IDS, "failure")
    rows = load_rows(tmp_path / "eval-reports", _steps(**outcomes))
    md, annotation = render(rows, suite="core", key_present=True)
    assert "本次未覆盖（真跑全部未出数）" in md
    assert annotation.startswith("::warning::")


def test_corrupt_report_is_surfaced(tmp_path: Path):
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    (reports / "style.json").write_text("{not json", encoding="utf-8")
    rows = load_rows(reports, _steps(**{sid: "success" for sid in _ALL_IDS}))
    md, _ = render(rows, suite="core", key_present=True)
    assert "报告无法解析" in md


def test_unknown_step_context_falls_back_to_not_run(tmp_path: Path):
    """steps 上下文缺失（作业早退）时按未执行渲染，不冒充通过。"""
    rows = load_rows(tmp_path / "eval-reports", {})
    md, _ = render(rows, suite="core", key_present=True)
    assert "本次未覆盖（真跑全部未出数）" in md


def test_preflight_failure_is_not_blamed_on_missing_key(tmp_path: Path):
    """连查 key 那步都没跑到时，别把「前置挂了」说成「没配 key」。"""
    rows = load_rows(tmp_path / "eval-reports", {})
    md, annotation = render(rows, suite="core", key_present=False, gate_reached=False)
    assert "本次未覆盖（真跑未启动）" in md
    assert "EVAL_DEEPSEEK_API_KEY" not in md
    assert "前置步骤挂了" in annotation


# --- CLI：写文件 + 恒 0 退出 --------------------------------------------------


def test_main_appends_markdown_and_never_reds(tmp_path: Path, monkeypatch, capsys):
    reports = tmp_path / "eval-reports"
    _full_green(reports)
    out = tmp_path / "summary.md"
    out.write_text("# 既有内容\n", encoding="utf-8")
    monkeypatch.setenv("EVAL_KEY_PRESENT", "true")
    monkeypatch.setenv("EVAL_STEPS_JSON", json.dumps(_steps(**dict.fromkeys(_ALL_IDS, "success"))))

    code = main(["--reports-dir", str(reports), "--out", str(out), "--suite", "core"])

    assert code == 0
    text = out.read_text(encoding="utf-8")
    assert text.startswith("# 既有内容")  # 追加而非覆盖（GITHUB_STEP_SUMMARY 语义）
    assert "AI 行为面：已覆盖，全部通过" in text
    assert "::notice::" in capsys.readouterr().out


def test_main_survives_broken_steps_json(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("EVAL_KEY_PRESENT", "false")
    monkeypatch.setenv("EVAL_STEPS_JSON", "not-json")
    code = main(["--reports-dir", str(tmp_path / "nope"), "--suite", "core"])
    assert code == 0
    assert "本次未覆盖" in capsys.readouterr().out


def test_main_no_key_path_names_the_missing_secret(tmp_path: Path, monkeypatch, capsys):
    """无 key 的真实形态：查 key 那步跑过并报 false。"""
    steps = _steps()
    steps["key"] = {"outcome": "success", "outputs": {"present": "false"}}
    monkeypatch.setenv("EVAL_KEY_PRESENT", "false")
    monkeypatch.setenv("EVAL_STEPS_JSON", json.dumps(steps))
    code = main(["--reports-dir", str(tmp_path / "nope"), "--suite", "core"])
    assert code == 0
    out = capsys.readouterr().out
    assert "AI 行为面：本次未覆盖" in out
    assert "EVAL_DEEPSEEK_API_KEY" in out
