"""Inherited nested code_audit discipline (parent gate → child tasks)."""

from __future__ import annotations

from agentcore.runtime.runs.playbooks.audit import (
    apply_inherited_code_audit_discipline,
    companion_audit_json_path,
)


def test_companion_audit_json_path():
    assert companion_audit_json_path("a/b.md") == "a/b.audit.json"
    assert companion_audit_json_path("a/b.txt") == "a/b.txt.audit.json"


def test_apply_inherited_stamps_gate_json_and_supplement():
    tasks = apply_inherited_code_audit_discipline(
        [
            {
                "role": "代码审计员",
                "task": "审 simulation",
                "deliverable": {
                    "form": "files",
                    "artifacts": ["AgentCore/文档/reviews/code-audit-2-simulation-sub.md"],
                },
            }
        ]
    )
    assert len(tasks) == 1
    d = tasks[0]["deliverable"]
    assert d["code_audit_gate"] is True
    assert d["artifacts"] == [
        "AgentCore/文档/reviews/code-audit-2-simulation-sub.md",
        "AgentCore/文档/reviews/code-audit-2-simulation-sub.audit.json",
    ]
    assert "嵌套审计·收工" in tasks[0]["system_prompt_supplement"]
    supp = tasks[0]["system_prompt_supplement"]
    assert "骨架先落 → 补全 → 成文" in supp
    # artifacts 声明不变：仍为 [md, companion .audit.json]
    assert d["artifacts"][0].endswith(".md")
    assert d["artifacts"][1].endswith(".audit.json")


def test_apply_inherited_preserves_explicit_gate_false():
    tasks = apply_inherited_code_audit_discipline(
        [
            {
                "role": "x",
                "task": "t",
                "deliverable": {"code_audit_gate": False, "artifacts": ["a.md"]},
            }
        ]
    )
    assert tasks[0]["deliverable"]["code_audit_gate"] is False
    assert "a.audit.json" in tasks[0]["deliverable"]["artifacts"]


def test_apply_inherited_does_not_duplicate_supplement():
    first = apply_inherited_code_audit_discipline(
        [
            {
                "role": "x",
                "task": "t",
                "deliverable": {"artifacts": ["r.md"]},
            }
        ]
    )
    again = apply_inherited_code_audit_discipline(first)
    assert again[0]["system_prompt_supplement"].count("嵌套审计·收工") == 1


def test_apply_inherited_skips_non_dicts():
    assert apply_inherited_code_audit_discipline(["nope", 1, None]) == []
