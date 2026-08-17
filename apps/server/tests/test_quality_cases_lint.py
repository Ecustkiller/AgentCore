"""Q7 wrapper: hard-only lint of the quality-case book + fixture classes.

仓根 ``evals/`` 不在 backend pytest 收集树内；本文件按规格用
``Path(__file__).resolve().parents[3] / "evals/quality-cases"`` 定位，只把 hard 档
送进门禁。合法/非法样例在 ``fixtures/``，不进 ``cases/``。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

QC_ROOT = Path(__file__).resolve().parents[3] / "evals" / "quality-cases"
if str(QC_ROOT) not in sys.path:
    sys.path.insert(0, str(QC_ROOT))

from lint_cases import lint_path, lint_tree, main  # noqa: E402

CASES = QC_ROOT / "cases"
LEGAL = QC_ROOT / "fixtures" / "legal"
ILLEGAL = QC_ROOT / "fixtures" / "illegal"
WARN = QC_ROOT / "fixtures" / "warn"

HARD_CLASSES = (
    ("transition.json", "transition"),
    ("matrix.json", "matrix"),
    ("repro_gate.json", "repro_gate"),
    ("regressed_id.json", "regressed_id"),
    ("nondefect_record.json", "nondefect_record"),
    ("rate_field.json", "rate_field"),
    ("body.json", "body"),
    ("intercept.json", "intercept"),
    ("production_ids.json", "production_ids"),
)


def _hard_codes(path: Path) -> set[str]:
    return {f.code for f in lint_path(path) if f.level == "hard"}


def test_live_casebook_hard_lint_clean() -> None:
    findings = lint_tree(CASES, hard_only=True)
    assert findings == []
    assert main(["--hard-only", str(CASES)]) == 0


def test_casebook_has_no_real_case_json() -> None:
    json_files = list(CASES.glob("*.json"))
    assert json_files == [], "真案目录起步为空；lint 样例不得进 cases/"


def test_legal_fixtures_hard_exit_zero() -> None:
    hard = [f for f in lint_path(LEGAL) if f.level == "hard"]
    assert hard == [], [f.format() for f in hard]
    assert main([str(LEGAL)]) == 0


@pytest.mark.parametrize(("filename", "code"), HARD_CLASSES)
def test_each_hard_class_fails(filename: str, code: str) -> None:
    path = ILLEGAL / filename
    codes = _hard_codes(path)
    assert code in codes, f"{filename}: expected {code}, got {sorted(codes)}"
    assert main([str(path)]) != 0


def test_warn_similar_does_not_fail_hard() -> None:
    findings = lint_path(WARN)
    hard = [f for f in findings if f.level == "hard"]
    warn = [f for f in findings if f.level == "warn"]
    assert hard == [], [f.format() for f in hard]
    assert any(f.code == "similar_case" for f in warn)
    assert main(["--hard-only", str(WARN)]) == 0
    assert main([str(WARN)]) == 0


def test_legal_open_fixture_is_q8_shape() -> None:
    data = json.loads((LEGAL / "open_undecided.json").read_text(encoding="utf-8"))
    assert data["status"] == "open"
    assert data["verdict"] == "undecided"
    assert data["history"] == []
    assert "first_user_preview" not in json.dumps(data)
    assert "last_user_preview" not in json.dumps(data)
