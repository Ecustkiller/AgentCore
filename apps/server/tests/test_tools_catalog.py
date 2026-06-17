"""Unit tests for the built-in tool catalog (the single-source registry).

``build_builtin_registry`` is the one place that declares "what tools ship with
the platform": the chat pipeline builds the worker toolset from it and the
``GET /tools`` catalog serializes it. These tests pin the roster and the
governance flags the UI renders, and guard that the CEO-only ``delegate``
primitive never leaks into the general catalog.
"""

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin import (
    build_builtin_registry,
    build_ceo_tool_registry,
    build_worker_registry,
    file_mutation_tool_names,
)

_EXPECTED_NAMES = {
    "web_search",
    "read_url",
    "file_read",
    "file_write",
    "str_replace",
    "file_list",
    "file_delete",
    "file_move",
    "grep",
    "code_execute",
}

# The CEO chat agent is a COORDINATOR: it directly holds only the read/retrieval
# tools and delegates every production/mutation tool to a worker (协调者 CEO).
_CEO_READONLY_NAMES = {"web_search", "read_url", "file_read", "file_list", "grep"}
_DELEGATED_MUTATION_NAMES = {
    "file_write",
    "str_replace",
    "file_delete",
    "file_move",
    "code_execute",
}


def test_registry_lists_exactly_the_builtin_tools():
    names = {schema.name for schema in build_builtin_registry().list_all()}
    assert names == _EXPECTED_NAMES


def test_registry_excludes_ceo_only_delegate():
    names = {schema.name for schema in build_builtin_registry().list_all()}
    assert "delegate" not in names


def test_worker_registry_adds_escalate_without_leaking_it():
    # escalate is the worker-only upward channel: present in the worker toolset, but
    # NOT in the builtin catalog (GET /tools) nor the CEO's own toolset (the CEO uses
    # ask_user, not escalate). This keeps the orchestration primitive where it belongs.
    worker = {s.name for s in build_worker_registry().list_all()}
    builtin = {s.name for s in build_builtin_registry().list_all()}
    ceo = {s.name for s in build_ceo_tool_registry().list_all()}
    assert "escalate" in worker
    assert worker == _EXPECTED_NAMES | {"escalate"}  # builtins + escalate, nothing else
    assert "escalate" not in builtin
    assert "escalate" not in ceo


def test_write_and_exec_tools_are_grantable():
    approvals = {s.name: s.approval for s in build_builtin_registry().list_all()}
    assert approvals["file_write"] is ToolApproval.GRANTABLE
    assert approvals["str_replace"] is ToolApproval.GRANTABLE
    assert approvals["code_execute"] is ToolApproval.GRANTABLE
    # Destructive / mutating file ops require the same consent as writes.
    assert approvals["file_delete"] is ToolApproval.GRANTABLE
    assert approvals["file_move"] is ToolApproval.GRANTABLE
    # Read-only tools auto-run (no approval prompt).
    assert approvals["file_read"] is ToolApproval.NEVER
    assert approvals["web_search"] is ToolApproval.NEVER


def test_file_mutation_class_is_grantable_filesystem_without_code_execute():
    # The「本轮内允许所有文件改动」class = GRANTABLE ∩ FILESYSTEM, so it covers the
    # file-edit tools but NOT code_execute (EXECUTION, higher-risk → its own gate).
    # Pinned so a future tool can't silently widen or narrow what one click grants.
    names = file_mutation_tool_names()
    assert names == {"file_write", "str_replace", "file_delete", "file_move"}
    assert "code_execute" not in names
    # Exactly the delegated mutation set minus code_execute (stays in lockstep).
    assert names == _DELEGATED_MUTATION_NAMES - {"code_execute"}


def test_code_execute_description_does_not_overpromise_sandbox():
    # In local mode code_execute runs on the user's REAL machine (workspace/local.py
    # forwards it to the desktop's bound directory), protected only by the approval
    # gate (P2d 执行门) — not an isolated sandbox. The old "sandboxed environment"
    # wording was false there; pin the honest framing so the model treats execution
    # with appropriate care and the claim can't silently regress.
    schemas = {s.name: s for s in build_builtin_registry().list_all()}
    desc = schemas["code_execute"].description
    assert "sandboxed environment" not in desc
    assert "用户自己的机器" in desc


def test_read_url_description_does_not_overclaim_completeness():
    # read_url caps extracted text at max_chars (default 8000), so a long page is
    # truncated — the description must disclose that and not promise the "complete"
    # body, or the model may state it read the whole page when it saw only the head.
    schemas = {s.name: s for s in build_builtin_registry().list_all()}
    desc = schemas["read_url"].description
    assert "max_chars" in desc  # truncation is disclosed
    assert "完整正文" not in desc  # no blanket "complete body" claim


def test_ceo_registry_is_read_only_subset():
    # 协调者 CEO: it looks + answers directly, so its direct toolset is exactly the
    # read/retrieval tools — no production/mutation tool leaks into the CEO's hands.
    names = {schema.name for schema in build_ceo_tool_registry().list_all()}
    assert names == _CEO_READONLY_NAMES


def test_ceo_registry_excludes_every_mutation_tool():
    names = {schema.name for schema in build_ceo_tool_registry().list_all()}
    assert names.isdisjoint(_DELEGATED_MUTATION_NAMES)


def test_ceo_registry_holds_only_auto_run_tools():
    # The split is by approval level: the CEO keeps only NEVER tools (auto-run, no
    # consent), while every GRANTABLE (env-mutating) tool is delegated. This pins
    # the rule that makes a new read-only tool reach the CEO automatically while a
    # new mutating tool stays worker-only.
    schemas = build_ceo_tool_registry().list_all()
    assert schemas, "CEO must retain its read/retrieval tools"
    assert all(s.approval is ToolApproval.NEVER for s in schemas)


def test_ceo_registry_excludes_delegate_primitive():
    # build_ceo_tool_registry returns only the read subset; the pipeline wires the
    # CEO-only delegate primitive separately, so it must not appear here.
    names = {schema.name for schema in build_ceo_tool_registry().list_all()}
    assert "delegate" not in names


def test_every_tool_exposes_catalog_fields():
    # The catalog endpoint serializes these straight to the UI, so each must be
    # populated with the right shapes.
    for schema in build_builtin_registry().list_all():
        assert schema.name and isinstance(schema.name, str)
        assert schema.description and isinstance(schema.description, str)
        assert isinstance(schema.category, ToolCategory)
        assert isinstance(schema.approval, ToolApproval)
        assert isinstance(schema.parameters, dict)
