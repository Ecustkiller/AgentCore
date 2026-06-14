"""Unit tests for the built-in tool catalog (the single-source registry).

``build_builtin_registry`` is the one place that declares "what tools ship with
the platform": the chat pipeline builds the worker toolset from it and the
``GET /tools`` catalog serializes it. These tests pin the roster and the
governance flags the UI renders, and guard that the CEO-only ``delegate``
primitive never leaks into the general catalog.
"""

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin import build_builtin_registry

_EXPECTED_NAMES = {
    "web_search",
    "read_url",
    "file_read",
    "file_write",
    "str_replace",
    "file_list",
    "grep",
    "code_execute",
}


def test_registry_lists_exactly_the_builtin_tools():
    names = {schema.name for schema in build_builtin_registry().list_all()}
    assert names == _EXPECTED_NAMES


def test_registry_excludes_ceo_only_delegate():
    names = {schema.name for schema in build_builtin_registry().list_all()}
    assert "delegate" not in names


def test_write_and_exec_tools_are_grantable():
    approvals = {s.name: s.approval for s in build_builtin_registry().list_all()}
    assert approvals["file_write"] is ToolApproval.GRANTABLE
    assert approvals["str_replace"] is ToolApproval.GRANTABLE
    assert approvals["code_execute"] is ToolApproval.GRANTABLE
    # Read-only tools auto-run (no approval prompt).
    assert approvals["file_read"] is ToolApproval.NEVER
    assert approvals["web_search"] is ToolApproval.NEVER


def test_every_tool_exposes_catalog_fields():
    # The catalog endpoint serializes these straight to the UI, so each must be
    # populated with the right shapes.
    for schema in build_builtin_registry().list_all():
        assert schema.name and isinstance(schema.name, str)
        assert schema.description and isinstance(schema.description, str)
        assert isinstance(schema.category, ToolCategory)
        assert isinstance(schema.approval, ToolApproval)
        assert isinstance(schema.parameters, dict)
