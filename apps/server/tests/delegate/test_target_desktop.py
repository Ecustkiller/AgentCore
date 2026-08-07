"""P0 桶 B: shape-甲 target desk + 2b bare-chat gate + nest inheritance."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.runtime.delegate.target_desktop import (
    NO_TARGET_SCRATCH_GATE_MSG,
    LocalRootClaimBook,
    TargetDesktopError,
    apply_target_desktop,
    effective_target_folder_id,
    gate_bare_chat_requires_target,
)
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.locate import LocalBinding


def test_effective_target_folder_id_prefers_explicit():
    assert effective_target_folder_id("  f1  ", default="f0") == "f1"
    assert effective_target_folder_id("", default="f0") == "f0"
    assert effective_target_folder_id(None, default=None) is None
    assert effective_target_folder_id("  ", default="  ") is None


def test_gate_bare_chat_blocks_without_target():
    msg = gate_bare_chat_requires_target(
        session_folder_id=None,
        tasks_raw=[{"role": "工", "task": "写文件"}],
    )
    assert msg == NO_TARGET_SCRATCH_GATE_MSG


def test_gate_bare_chat_allows_with_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[{"role": "工", "task": "写", "target_folder_id": "proj_a"}],
        )
        is None
    )


def test_gate_birth_allows_omit_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id="birth",
            tasks_raw=[{"role": "工", "task": "写"}],
        )
        is None
    )


def test_gate_bare_inherits_default_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[{"role": "子", "task": "续"}],
            default_target_folder_id="parent_desk",
        )
        is None
    )


def test_build_run_plan_stamps_target_folder_id():
    plan, errors = build_run_plan(
        [
            {
                "role": "甲",
                "task": "在 A 写",
                "target_folder_id": "folder_a",
            },
            {"role": "乙", "task": "默认桌"},
        ]
    )
    assert errors == []
    by_role = {n.role: n for n in plan.nodes}
    assert by_role["甲"].target_folder_id == "folder_a"
    assert by_role["乙"].target_folder_id is None


def test_build_run_plan_inherits_default_target():
    plan, errors = build_run_plan(
        [{"role": "子", "task": "继承"}],
        default_target_folder_id="parent_x",
    )
    assert errors == []
    assert plan.nodes[0].target_folder_id == "parent_x"


def test_build_run_plan_explicit_overrides_default():
    plan, errors = build_run_plan(
        [{"role": "子", "task": "换桌", "target_folder_id": "other"}],
        default_target_folder_id="parent_x",
    )
    assert errors == []
    assert plan.nodes[0].target_folder_id == "other"


@pytest.mark.asyncio
async def test_local_root_claim_book_allows_second_root():
    """C0：不同 local root 同回合均可认领（不再拒第二根）。"""
    book = LocalRootClaimBook()
    assert await book.try_claim("root_a") is True
    assert await book.try_claim("root_a") is True
    assert await book.try_claim("root_b") is True


@pytest.mark.asyncio
async def test_apply_target_desktop_same_as_session_is_noop():
    backend = SimpleNamespace(location="server")
    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=backend,  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    tools = ToolRegistry()
    applied = await apply_target_desktop(
        target_folder_id="same",
        session_folder_id="same",
        env_system_prompt="PROMPT",
        base_tool_context=ctx,
        worker_tools=tools,
        sink=MagicMock(),
        local_root_claims=None,
    )
    assert applied.system_prompt == "PROMPT"
    assert applied.tool_ctx is ctx
    assert applied.worker_tools is tools


@pytest.mark.asyncio
async def test_apply_target_desktop_switches_backend_and_memory():
    session_backend = SimpleNamespace(location="server", _channel=None)
    target_backend = SimpleNamespace(location="server", _channel=None)
    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=session_backend,  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    tools = ToolRegistry()
    binding = SimpleNamespace(
        folder_id="target_f",
        name="目标项目",
        local_binding=None,
    )

    async def _fake_rebuild(**_kwargs):
        return "TARGET_PROMPT", False

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
            target_folder_id="target_f",
            session_folder_id="birth_f",
            env_system_prompt="OLD",
            base_tool_context=ctx,
            worker_tools=tools,
            sink=MagicMock(),
            local_root_claims=LocalRootClaimBook(),
        )

    assert applied.system_prompt == "TARGET_PROMPT"
    assert applied.tool_ctx.backend is target_backend
    assert applied.tool_ctx.shared_workspace is True
    assert applied.target_folder_id == "target_f"


@pytest.mark.asyncio
async def test_apply_target_desktop_unknown_folder_errors():
    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=SimpleNamespace(location="server"),  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    with patch(
        "agentcore.runtime.delegate.target_desktop.load_target_folder_binding",
        new=AsyncMock(return_value=None),
    ), pytest.raises(TargetDesktopError, match="不存在或无权"):
        await apply_target_desktop(
            target_folder_id="missing",
            session_folder_id=None,
            env_system_prompt="P",
            base_tool_context=ctx,
            worker_tools=ToolRegistry(),
            sink=MagicMock(),
            local_root_claims=None,
        )


@pytest.mark.asyncio
async def test_apply_target_desktop_allows_second_local_root():
    """C0：会话已占一本地根时，异本地根 prepare 放行（ClaimBook 不拒）。"""
    session_backend = SimpleNamespace(
        location="local",
        _channel=SimpleNamespace(root_id="root_session"),
    )
    target_backend = SimpleNamespace(
        location="local",
        _channel=SimpleNamespace(root_id="root_other"),
    )
    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=session_backend,  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    claims = LocalRootClaimBook()
    await claims.seed_from_backend(session_backend)  # type: ignore[arg-type]
    binding = SimpleNamespace(
        folder_id="local_b",
        name="本地B",
        local_binding=LocalBinding(root_id="root_other", root_label="B"),
    )

    async def _fake_rebuild(**_kwargs):
        return "LOCAL_B_PROMPT", False

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
            target_folder_id="local_b",
            session_folder_id="birth",
            env_system_prompt="P",
            base_tool_context=ctx,
            worker_tools=ToolRegistry(),
            sink=MagicMock(),
            local_root_claims=claims,
        )

    assert applied.target_folder_id == "local_b"
    assert applied.tool_ctx.backend is target_backend
    assert applied.system_prompt == "LOCAL_B_PROMPT"
    assert await claims.try_claim("root_other") is True


@pytest.mark.asyncio
async def test_apply_target_desktop_mixed_local_and_cloud():
    """混部：本地根已登记时，cloud异桌仍放行。"""
    session_backend = SimpleNamespace(
        location="local",
        _channel=SimpleNamespace(root_id="root_session"),
    )
    cloud_backend = SimpleNamespace(location="server", _channel=None)
    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=session_backend,  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    claims = LocalRootClaimBook()
    await claims.seed_from_backend(session_backend)  # type: ignore[arg-type]
    binding = SimpleNamespace(
        folder_id="cloud_c",
        name="云C",
        local_binding=None,
    )

    async def _fake_rebuild(**_kwargs):
        return "CLOUD_PROMPT", False

    with (
        patch(
            "agentcore.runtime.delegate.target_desktop.load_target_folder_binding",
            new=AsyncMock(return_value=binding),
        ),
        patch(
            "agentcore.runtime.delegate.target_desktop.build_target_backend",
            return_value=cloud_backend,
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
            target_folder_id="cloud_c",
            session_folder_id="birth",
            env_system_prompt="P",
            base_tool_context=ctx,
            worker_tools=ToolRegistry(),
            sink=MagicMock(),
            local_root_claims=claims,
        )

    assert applied.target_folder_id == "cloud_c"
    assert applied.tool_ctx.backend is cloud_backend
    assert applied.system_prompt == "CLOUD_PROMPT"


@pytest.mark.asyncio
async def test_delegate_execute_bare_chat_gate(monkeypatch):
    """DelegateTool.execute rejects bare chat without target before drive."""
    from agentcore.llm.provider.protocol import LLMProvider
    from agentcore.runtime.events import EventSink
    from agentcore.tools.builtin.delegate.tool import DelegateTool

    class _DummyLLM(LLMProvider):
        async def complete(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise NotImplementedError

        async def stream(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise NotImplementedError
            yield  # pragma: no cover

    backend = SimpleNamespace(location="server")
    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=backend,  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    t = DelegateTool(
        llm=_DummyLLM(),  # type: ignore[arg-type]
        sink=EventSink(),
        system_prompt="sys",
        user_message="user",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=ctx,
        folder_id=None,
        captain_run_id="CEO",
    )
    recorded: list[dict[str, object]] = []

    def _capture(event: str, **fields: object) -> None:
        if event == "delegate.bare_chat_no_target_rejected":
            recorded.append(fields)

    import agentcore.tools.builtin.delegate.tool as delegate_tool_mod

    monkeypatch.setattr(
        delegate_tool_mod.logger,
        "info",
        lambda event, **fields: _capture(event, **fields),
    )

    result = await t.execute(
        {"tasks": [{"role": "工", "task": "写 README"}]},
        ctx,
    )
    assert result.success is False
    assert result.contract_failure is True
    assert "scratch" in (result.error or "") or "目标项目" in (result.error or "")
    assert recorded and recorded[0].get("session_folder_id") is None
