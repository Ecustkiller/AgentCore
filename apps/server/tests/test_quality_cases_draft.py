"""Q8 draft_from_patrol: snapshot → open/undecided cards, no user previews."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

QC_ROOT = Path(__file__).resolve().parents[3] / "evals" / "quality-cases"
if str(QC_ROOT) not in sys.path:
    sys.path.insert(0, str(QC_ROOT))

from draft_from_patrol import (  # noqa: E402
    DraftError,
    draft_cases,
    main,
)
from lint_cases import lint_document  # noqa: E402

SNAPSHOT = QC_ROOT / "fixtures" / "snapshots" / "patrol_draft.json"
PREVIEW_A = "帮我对齐 UI 风格并且不要写进任何案卡字段"
PREVIEW_B = "把按钮改成品牌蓝然后把间距也调一下谢谢"
TID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CID = "11111111-2222-3333-4444-555555555555"


@pytest.fixture()
def snapshot() -> dict:
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def test_drafts_are_open_undecided_and_lint_clean(snapshot: dict) -> None:
    cards = draft_cases(snapshot, signal_tier="dogfood")
    assert {c["id"] for c in cards} >= {
        "qc-20260817-write-pass-exhausted",
        "qc-20260817-unknown-or-new",
        "qc-20260817-stream-stall",
    }
    for card in cards:
        assert card["status"] == "open"
        assert card["verdict"] == "undecided"
        assert card["opened_by"] == "patrol"
        assert card["history"] == []
        hard = [f for f in lint_document(card, source=card["id"]) if f.level == "hard"]
        assert hard == [], [f.format() for f in hard]


def test_copies_snapshot_ids_only(snapshot: dict) -> None:
    cards = {c["family"] or c["family_candidate"]: c for c in draft_cases(snapshot, signal_tier="dogfood")}
    exhausted = cards["write_pass_exhausted"]
    assert exhausted["evidence"]["traces"] == [TID]
    assert exhausted["evidence"]["conversations"] == [CID]
    residual = cards["unknown_or_new"]
    assert residual["family"] is None
    assert residual["family_candidate"] == "unknown_or_new"


def test_never_copies_user_previews(snapshot: dict) -> None:
    blob = json.dumps(draft_cases(snapshot, signal_tier="dogfood"), ensure_ascii=False)
    assert "first_user_preview" not in blob
    assert "last_user_preview" not in blob
    assert PREVIEW_A not in blob
    assert PREVIEW_B not in blob
    assert "对齐首页" not in blob


def test_production_skips_family_without_ids(snapshot: dict) -> None:
    cards = draft_cases(snapshot, signal_tier="production")
    keys = {c["family"] or c["family_candidate"] for c in cards}
    assert "write_pass_exhausted" in keys
    assert "stream_stall" not in keys


def test_does_not_invent_ids(snapshot: dict) -> None:
    snapshot["families"]["write_pass_exhausted"]["traces"] = {
        "ids": [],
        "total": 9,
        "truncated": True,
    }
    snapshot["families"]["write_pass_exhausted"]["conversations"] = {
        "ids": [],
        "total": 9,
        "truncated": True,
    }
    cards = draft_cases(snapshot, signal_tier="dogfood", family="write_pass_exhausted")
    assert len(cards) == 1
    assert cards[0]["evidence"]["traces"] == []
    assert cards[0]["evidence"]["conversations"] == []


def test_refuses_preview_values_even_if_forced(snapshot: dict) -> None:
    snapshot["families"]["write_pass_exhausted"]["traces"]["ids"] = [TID]
    cards = draft_cases(snapshot, signal_tier="dogfood", family="write_pass_exhausted")
    cards[0]["symptom"] = PREVIEW_A
    with pytest.raises(DraftError, match="preview"):
        from draft_from_patrol import _assert_no_preview_leak, _collect_previews

        _assert_no_preview_leak(cards[0], _collect_previews(snapshot))


def test_cli_dry_run_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "cases"
    assert (
        main(
            [
                "--snapshot",
                str(SNAPSHOT),
                "--out-dir",
                str(out),
                "--family",
                "write_pass_exhausted",
                "--dry-run",
            ]
        )
        == 0
    )
    assert list(out.glob("*.json")) == []
    printed = capsys.readouterr().out
    assert "qc-20260817-write-pass-exhausted" in printed
    assert PREVIEW_A not in printed


def test_cli_writes_draft_json(tmp_path: Path) -> None:
    out = tmp_path / "cases"
    assert (
        main(
            [
                "--snapshot",
                str(SNAPSHOT),
                "--out-dir",
                str(out),
                "--family",
                "write_pass_exhausted",
            ]
        )
        == 0
    )
    dest = out / "qc-20260817-write-pass-exhausted.json"
    data = json.loads(dest.read_text(encoding="utf-8"))
    assert data["status"] == "open"
    assert data["verdict"] == "undecided"
    text = dest.read_text(encoding="utf-8")
    assert PREVIEW_A not in text
    assert "first_user_preview" not in text
