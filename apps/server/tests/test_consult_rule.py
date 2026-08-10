"""Tests for on_demand user rules + consult_rule (定案 B).

Covers:
1. ``ConsultRuleTool`` — hit / soft miss / missing name (Consultable shape).
2. Directory rendering + CEO/worker prompt gating (only when consult_rule wired).
3. Assembly — empty on_demand catalog ⇒ tool omitted (CEO + worker).
4. apply_mode API schema — always|on_demand accepted; conditional rejected by Literal.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from agentcore.api.routes.documents import DocumentCreateRequest, DocumentPatchRequest
from agentcore.core.types import ToolCategory
from agentcore.memory.rules_injection import OnDemandUserRule, rule_consult_name
from agentcore.runtime.context.consultable import Consultable, ConsultDirectoryEntry
from agentcore.runtime.resolve.prepare import _wire_worker_memory_tools
from agentcore.runtime.resolve.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    compose_worker_base_prompt,
    render_rule_directory,
    render_worker_rule_directory,
)
from agentcore.runtime.skills import build_system_skill_registry
from agentcore.tools.builtin import build_worker_registry
from agentcore.tools.builtin.consult_rule import ConsultRuleTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(user_id: str = "u") -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id=user_id,
    )


# --- apply_mode API validation -------------------------------------------------


def test_create_request_accepts_always_and_on_demand():
    assert DocumentCreateRequest(name="r.md", role="rule").apply_mode == "always"
    assert (
        DocumentCreateRequest(name="r.md", role="rule", apply_mode="on_demand").apply_mode
        == "on_demand"
    )


def test_create_request_rejects_conditional():
    with pytest.raises(ValidationError):
        DocumentCreateRequest(name="r.md", role="rule", apply_mode="conditional")  # type: ignore[arg-type]


def test_patch_request_rejects_conditional():
    with pytest.raises(ValidationError):
        DocumentPatchRequest(apply_mode="conditional")  # type: ignore[arg-type]


def test_rule_consult_name_strips_md():
    assert rule_consult_name("合规附录.md") == "合规附录"
    assert rule_consult_name("合规附录") == "合规附录"


# --- Consultable shape ---------------------------------------------------------


def test_consult_rule_implements_consultable_protocol():
    tool = ConsultRuleTool()
    assert isinstance(tool, Consultable)


# --- consult_rule tool ---------------------------------------------------------


def test_consult_rule_schema_is_orchestration_primitive():
    schema = ConsultRuleTool().schema
    assert schema.name == "consult_rule"
    assert schema.category is ToolCategory.ORCHESTRATION
    assert "name" in schema.parameters["properties"]


async def test_consult_rule_returns_body_on_hit():
    tool = ConsultRuleTool()
    body = "- 对外沟通须用中文\n"

    async def _fetch(_uid: str, name: str) -> str | None:
        return body if name == "合规附录" else None

    with (
        patch.object(tool, "fetch_by_name", AsyncMock(side_effect=_fetch)),
        patch.object(tool, "_available_names", AsyncMock(return_value=["合规附录"])),
    ):
        result = await tool.execute({"name": "合规附录"}, _ctx())
    assert result.success
    assert result.output == body
    assert result.display == {"rule": "合规附录"}


async def test_consult_rule_name_spelling_accepts_md_suffix():
    tool = ConsultRuleTool()
    body = "- x\n"

    async def _fetch(_uid: str, name: str) -> str | None:
        return body if name == "合规附录" else None

    with patch.object(tool, "fetch_by_name", AsyncMock(side_effect=_fetch)):
        result = await tool.execute({"name": "合规附录.md"}, _ctx())
    assert result.success
    assert result.output == body


async def test_consult_rule_soft_miss_on_unknown_name():
    tool = ConsultRuleTool()
    with (
        patch.object(tool, "fetch_by_name", AsyncMock(return_value=None)),
        patch.object(
            tool, "_available_names", AsyncMock(return_value=["合规附录", "出差报销"])
        ),
    ):
        result = await tool.execute({"name": "不存在"}, _ctx())
    assert result.success
    assert result.error is None
    assert "合规附录" in result.output
    assert "出差报销" in result.output


async def test_consult_rule_missing_name_is_hard_fail():
    tool = ConsultRuleTool()
    with patch.object(tool, "_available_names", AsyncMock(return_value=["合规附录"])):
        result = await tool.execute({}, _ctx())
    assert not result.success
    assert result.error
    assert "name" in result.output


async def test_consult_rule_reports_empty_library():
    tool = ConsultRuleTool()
    with (
        patch.object(tool, "fetch_by_name", AsyncMock(return_value=None)),
        patch.object(tool, "_available_names", AsyncMock(return_value=[])),
    ):
        result = await tool.execute({"name": "随便"}, _ctx())
    assert result.success
    assert "没有任何按需用户规则" in result.output


async def test_consult_rule_list_directory_shape():
    tool = ConsultRuleTool()
    with patch.object(tool, "_available_names", AsyncMock(return_value=["a", "b"])):
        entries = await tool.list_directory("u")
    assert entries == [
        ConsultDirectoryEntry(name="a"),
        ConsultDirectoryEntry(name="b"),
    ]


# --- directory rendering + prompt gating ---------------------------------------


def test_rule_directory_lists_names_and_points_at_consult():
    out = render_rule_directory(
        [OnDemandUserRule("合规附录", "对外须用中文"), OnDemandUserRule("出差报销", "")]
    )
    assert "<规则目录>" in out and "</规则目录>" in out
    assert "consult_rule" in out
    assert "- 合规附录：对外须用中文" in out
    assert "- 出差报销" in out and "- 出差报销：" not in out
    assert "consult_memory" in out  # steer away from merging with memory topics


def test_rule_directory_empty_when_no_rules():
    assert render_rule_directory([]) == ""


def test_ceo_prompt_lists_rule_directory_only_when_consult_rule_wired():
    base = assemble_system_prompt()
    registry = build_system_skill_registry()
    rules = [OnDemandUserRule("合规附录", "对外须用中文")]

    with_tool = compose_ceo_chat_prompt(
        base,
        skill_registry=registry,
        ceo_tool_names={"delegate", "consult_skill", "consult_rule"},
        on_demand_rules=rules,
    )
    assert "<规则目录>" in with_tool
    assert "- 合规附录：对外须用中文" in with_tool

    without_tool = compose_ceo_chat_prompt(
        base,
        skill_registry=registry,
        ceo_tool_names={"delegate", "consult_skill"},
        on_demand_rules=rules,
    )
    assert "<规则目录>" not in without_tool


def test_worker_prompt_includes_rule_directory_when_catalog_nonempty():
    base = assemble_system_prompt()
    with_rules = compose_worker_base_prompt(
        base, on_demand_rules=[OnDemandUserRule("合规附录", "x")]
    )
    assert "<规则目录>" in with_rules
    assert "consult_rule" in with_rules
    assert render_worker_rule_directory([OnDemandUserRule("合规附录", "x")]) in with_rules

    empty = compose_worker_base_prompt(base, on_demand_rules=[])
    assert "<规则目录>" not in empty


# --- assembly wiring -----------------------------------------------------------


def _assemble_chat_tools(*, has_on_demand_rules: bool = True, folder_id: str | None = None):
    from agentcore.llm.profiles import default_turn_profiles as default_profile_set
    from agentcore.runtime.events import EventSink
    from agentcore.runtime.resolve.prepare import _assemble_ceo_toolset
    from agentcore.tools.registry import ToolRegistry

    _, _, chat_tools = _assemble_ceo_toolset(
        llm=object(),
        sink=EventSink(),
        base_system_prompt="SYS",
        user_message="原始请求",
        history=[],
        worker_tools=ToolRegistry(),
        base_tool_context=_ctx(),
        profiles=default_profile_set(),
        approval_gate=None,
        session_store=None,
        session_saver=None,
        session_loader=None,
        conversation_id="c",
        captain_run_id="cap",
        checkpoint_enabled=False,
        message_id="m",
        suspension_saver=None,
        suspension_deleter=None,
        backend_location="server",
        skill_registry=build_system_skill_registry(),
        memory_enabled=True,
        folder_id=folder_id,
        has_memory_topics=False,
        has_on_demand_rules=has_on_demand_rules,
    )
    return chat_tools


def test_assemble_wires_consult_rule_when_catalog_nonempty():
    tools = _assemble_chat_tools(has_on_demand_rules=True, folder_id="F1")
    cr = tools.get_optional("consult_rule")
    assert cr is not None
    assert cr.folder_id == "F1"


def test_assemble_omits_consult_rule_when_catalog_empty():
    tools = _assemble_chat_tools(has_on_demand_rules=False)
    assert tools.get_optional("consult_rule") is None


def test_worker_wire_omits_consult_rule_when_empty():
    worker_tools = build_worker_registry()
    _wire_worker_memory_tools(
        worker_tools, memory_enabled=True, folder_id="F1", has_on_demand_rules=False
    )
    assert worker_tools.get_optional("consult_rule") is None


def test_worker_wire_registers_consult_rule_when_present():
    worker_tools = build_worker_registry()
    _wire_worker_memory_tools(
        worker_tools, memory_enabled=False, folder_id="F1", has_on_demand_rules=True
    )
    # Independent of memory_enabled.
    cr = worker_tools.get_optional("consult_rule")
    assert cr is not None
    assert cr.folder_id == "F1"
