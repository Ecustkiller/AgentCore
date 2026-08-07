"""跨项目指挥金标链（§4.2b / §4.11）：解析 → target_folder_id → 异桌+记忆；附 2b 闸。

紧凑集成向：复用 projects 工具 mock + target_desktop 接线，不跑端到端 UI。
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.llm.provider.protocol import LLMProvider
from agentcore.runtime.delegate.target_desktop import (
    NO_TARGET_SCRATCH_GATE_MSG,
    LocalRootClaimBook,
    apply_target_desktop,
)
from agentcore.runtime.events import EventSink
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.tools.builtin.consult_memory import ConsultMemoryTool
from agentcore.tools.builtin.delegate.tool import DelegateTool
from agentcore.tools.builtin.projects import ListProjectsTool, ResolveProjectTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from tests.test_projects_tools import _FakeFolder, _ctx, _patch_list


def _birth_ctx(
    *,
    user_id: str = "u1",
    conversation_id: str = "c-cmd",
    backend: object | None = None,
) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=(backend or SimpleNamespace(location="server")),  # type: ignore[arg-type]
        user_id=user_id,
        conversation_id=conversation_id,
    )


@pytest.mark.asyncio
async def test_resolve_delegate_target_desk_and_memory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """金标：列/解析唯一命中 → plan 带 target_folder_id → worker 桌+记忆跟目标。"""
    _patch_list(
        monkeypatch,
        [
            _FakeFolder(id="birth_f", name="Birth Desk"),
            _FakeFolder(id="proj_alpha", name="Alpha App"),
            _FakeFolder(id="proj_beta", name="Beta App"),
        ],
    )
    ceo_ctx = _ctx(user_id="owner-1", conversation_id="cmd-1")

    listed = await ListProjectsTool().execute({}, ceo_ctx)
    assert listed.success
    roster = json.loads(listed.output.split("\n", 1)[1])
    assert {p["id"] for p in roster["projects"]} >= {"proj_alpha", "proj_beta"}

    resolved = await ResolveProjectTool().execute({"name": "Alpha App"}, ceo_ctx)
    assert resolved.success
    assert resolved.display["status"] == "resolved"
    target_id = resolved.display["folder_id"]
    assert target_id == "proj_alpha"

    plan, errors = build_run_plan(
        [
            {
                "role": "甲",
                "task": "在 Alpha 写入口",
                "target_folder_id": target_id,
            },
            {
                "role": "乙",
                "task": "在 Beta 写入口",
                "target_folder_id": "proj_beta",
            },
        ]
    )
    assert errors == []
    by_role = {n.role: n for n in plan.nodes}
    assert by_role["甲"].target_folder_id == "proj_alpha"
    assert by_role["乙"].target_folder_id == "proj_beta"

    session_backend = SimpleNamespace(location="server", _channel=None)
    target_backend = SimpleNamespace(location="server", _channel=None)
    base_ctx = _birth_ctx(user_id="owner-1", backend=session_backend)
    # Seed birth-scoped consult_memory so rewire must replace it with target scope.
    birth_tools = ToolRegistry()
    birth_tools.register(
        ConsultMemoryTool(store=MagicMock(), folder_id="birth_f")
    )
    binding = SimpleNamespace(
        folder_id="proj_alpha",
        name="Alpha App",
        local_binding=None,
    )

    async def _fake_rebuild(**_kwargs):
        # has_memory_topics=True → consult_memory rewired to target folder.
        return "PROMPT_FOR_ALPHA", True

    with (
        patch(
            "agentcore.runtime.delegate.target_desktop.load_target_folder_binding",
            new=AsyncMock(return_value=binding),
        ),
        patch(
            "agentcore.runtime.delegate.target_desktop.build_target_backend",
            return_value=target_backend,
        ),
        patch(
            "agentcore.runtime.delegate.target_desktop.rebuild_worker_prompt_for_target",
            new=_fake_rebuild,
        ),
        patch(
            "agentcore.workspace.locate.workspace_channel_for_tools",
            return_value=None,
        ),
    ):
        applied = await apply_target_desktop(
            target_folder_id=by_role["甲"].target_folder_id or "",
            session_folder_id="birth_f",
            env_system_prompt="BIRTH_PROMPT",
            base_tool_context=base_ctx,
            worker_tools=birth_tools,
            sink=MagicMock(),
            local_root_claims=LocalRootClaimBook(),
            memory_enabled=True,
        )

    assert applied.target_folder_id == "proj_alpha"
    assert applied.tool_ctx.backend is target_backend
    assert applied.tool_ctx.backend is not session_backend
    assert applied.system_prompt == "PROMPT_FOR_ALPHA"
    memory_tool = applied.worker_tools.get("consult_memory")
    assert isinstance(memory_tool, ConsultMemoryTool)
    assert memory_tool.folder_id == "proj_alpha"
    assert memory_tool.folder_id != "birth_f"


@pytest.mark.asyncio
async def test_bare_chat_no_target_blocked_by_2b_gate() -> None:
    """§4.2b·2b：无出生 + 未点名 → DelegateTool 在 drive 前硬拒（禁默写 scratch）。"""

    class _DummyLLM(LLMProvider):
        async def complete(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise NotImplementedError

        async def stream(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise NotImplementedError
            yield  # pragma: no cover

    ctx = _birth_ctx()
    tool = DelegateTool(
        llm=_DummyLLM(),  # type: ignore[arg-type]
        sink=EventSink(),
        system_prompt="sys",
        user_message="三个项目并行开发",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=ctx,
        folder_id=None,
        captain_run_id="CEO",
    )
    result = await tool.execute(
        {"tasks": [{"role": "工", "task": "写 README"}]},
        ctx,
    )
    assert result.success is False
    assert result.contract_failure is True
    assert result.error == NO_TARGET_SCRATCH_GATE_MSG
    assert "scratch" in (result.error or "")
    assert "target_folder_id" in (result.error or "")
