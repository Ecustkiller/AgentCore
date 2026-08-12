"""documents_fixture 静态校验 + 装载（零 LLM / 零 DB）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentcore.evals import documents_fixture as docs_fx_mod
from agentcore.evals.documents_fixture import (
    lint_documents_fixture_dir,
    load_documents_manifest,
)
from agentcore.evals.runner import load_cases
from agentcore.evals.seed_lint import lint_case, lint_suite
from agentcore.evals.types import EvalConfigError

_FIXTURES = Path(docs_fx_mod.__file__).resolve().parent / "fixtures"
_CASES = Path(docs_fx_mod.__file__).resolve().parent / "cases"


def test_shipped_rules_memory_suite_lints_clean():
    cases = load_cases(_CASES, suite="rules_memory")
    assert len(cases) >= 5
    assert all(c.documents_fixture for c in cases)
    assert all(c.path == "team" for c in cases)


def test_shipped_documents_fixtures_lint_clean():
    names = [
        "docs_memory_launch_code",
        "docs_memory_two_ports",
        "docs_always_rule_token",
        "docs_always_rule_eli5",
        "docs_ondemand_rule_secret",
    ]
    for name in names:
        errors = lint_documents_fixture_dir("t", _FIXTURES / name)
        assert errors == [], f"{name}: {errors}"


def test_lint_documents_fixture_missing_dir(tmp_path: Path):
    errors = lint_case(
        {
            "id": "x",
            "category": "qa",
            "user_message": "q",
            "checks": [{"name": "NonEmpty"}],
            "documents_fixture": "nope",
        },
        fixtures_dir=tmp_path,
    )
    assert any("documents_fixture 目录不存在" in e for e in errors)


def test_lint_documents_fixture_bad_manifest(tmp_path: Path):
    root = tmp_path / "bad"
    root.mkdir()
    (root / "documents.json").write_text('{"entries": []}', encoding="utf-8")
    errors = lint_documents_fixture_dir("x", root)
    assert any("非空列表" in e for e in errors)


def test_load_manifest_resolves_file_body(tmp_path: Path):
    root = tmp_path / "fx"
    (root / "bodies").mkdir(parents=True)
    (root / "bodies" / "a.md").write_text("SECRET_BODY", encoding="utf-8")
    (root / "documents.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "layer": "user_rule",
                        "name": "a.md",
                        "apply_mode": "on_demand",
                        "file": "bodies/a.md",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    manifest = load_documents_manifest(root)
    assert len(manifest.entries) == 1
    assert manifest.entries[0].content == "SECRET_BODY"


def test_load_manifest_rejects_path_escape(tmp_path: Path):
    root = tmp_path / "fx"
    root.mkdir()
    (root / "documents.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "layer": "user_rule",
                        "name": "a.md",
                        "apply_mode": "always",
                        "file": "../outside.md",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    errors = lint_documents_fixture_dir("x", root)
    assert any("越出夹具根" in e or "不存在" in e for e in errors)
    with pytest.raises(EvalConfigError):
        load_documents_manifest(root)


def test_lint_suite_accepts_valid_documents_fixture(tmp_path: Path):
    fx = tmp_path / "ok"
    fx.mkdir()
    (fx / "documents.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "layer": "memory",
                        "path": "主题/x.md",
                        "content": "hi",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    errors = lint_suite(
        [
            {
                "id": "c1",
                "category": "qa",
                "user_message": "q",
                "checks": [{"name": "NonEmpty"}],
                "documents_fixture": "ok",
            }
        ],
        fixtures_dir=tmp_path,
    )
    assert errors == []
