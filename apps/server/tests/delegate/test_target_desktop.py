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
    format_bare_chat_no_target_error,
    gate_bare_chat_requires_target,
    load_target_folder_binding,
    resolve_bare_chat_write_scope,
    task_structurally_requires_write_desk,
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


def test_task_structurally_requires_write_desk():
    assert task_structurally_requires_write_desk({"task": "打招呼"}) is False
    assert task_structurally_requires_write_desk(
        {"deliverable": {"form": "prose"}}
    ) is False
    assert task_structurally_requires_write_desk({"deliverable": {}}) is False
    assert task_structurally_requires_write_desk(
        {"deliverable": {"form": "files"}}
    ) is True
    assert task_structurally_requires_write_desk(
        {"deliverable": {"requires_files": True}}
    ) is True
    assert task_structurally_requires_write_desk(
        {"deliverable": {"requires_files": False}}
    ) is False
    assert task_structurally_requires_write_desk(
        {"deliverable": {"artifacts": ["a.py"]}}
    ) is True
    assert task_structurally_requires_write_desk(
        {"deliverable": {"artifacts": ["  ", ""]}}
    ) is False
    assert task_structurally_requires_write_desk(
        {"deliverable": {"artifacts": []}}
    ) is False


def test_resolve_bare_chat_write_scope():
    assert (
        resolve_bare_chat_write_scope(
            target_folder_id=None,
            session_folder_id=None,
            base_write_scope="project",
        )
        == "none"
    )
    assert (
        resolve_bare_chat_write_scope(
            target_folder_id=None,
            session_folder_id=None,
            base_write_scope="explore_memory",
        )
        == "explore_memory"
    )
    assert (
        resolve_bare_chat_write_scope(
            target_folder_id="t",
            session_folder_id=None,
            base_write_scope="project",
        )
        == "project"
    )
    assert (
        resolve_bare_chat_write_scope(
            target_folder_id=None,
            session_folder_id="birth",
            base_write_scope="project",
        )
        == "project"
    )


def test_gate_bare_chat_blocks_write_deliverable_without_target():
    """纯闸：无目标 + form=files → 拒（ensure 未跑时的残余拒文案）。"""
    msg = gate_bare_chat_requires_target(
        session_folder_id=None,
        tasks_raw=[
            {
                "role": "工",
                "task": "写文件勿泄露正文",
                "deliverable": {"form": "files"},
            }
        ],
    )
    assert msg is not None
    assert msg.startswith(NO_TARGET_SCRATCH_GATE_MSG)
    assert "写盘任务必须点名" in msg
    assert "纯对话/只读可不点名" in msg
    assert "create" not in msg.lower()
    assert "ask_user" not in msg
    assert "缺目标任务：" in msg
    assert "role=工" in msg
    assert "缺 target_folder_id" in msg
    assert "写文件勿泄露正文" not in msg


def test_gate_bare_chat_allows_prose_and_no_deliverable():
    """无 deliverable / form=prose → 放行（坐 scratch、禁写由 write_scope 管）。"""
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[{"role": "客服", "task": "打招呼"}],
        )
        is None
    )
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[
                {
                    "role": "写手",
                    "task": "写段说明",
                    "deliverable": {"form": "prose"},
                }
            ],
        )
        is None
    )


def test_gate_bare_chat_lists_all_missing_write_targets():
    """部分缺 target 的写盘 task → 整批拒，回执只点名写盘缺项。"""
    msg = gate_bare_chat_requires_target(
        session_folder_id=None,
        tasks_raw=[
            {
                "role": "甲",
                "task": "有目标正文勿泄露",
                "target_folder_id": "proj_a",
                "deliverable": {"form": "files"},
            },
            {
                "id": "n2",
                "role": "乙",
                "task": "缺目标的长任务说明不应出现",
                "deliverable": {"form": "files"},
            },
            {
                "role": "丙",
                "task": "也缺写盘",
                "deliverable": {"requires_files": True},
            },
            {"role": "丁", "task": "纯对话不进拒名单"},
        ],
    )
    assert msg is not None
    assert msg.startswith(NO_TARGET_SCRATCH_GATE_MSG)
    assert "role=乙" in msg and "id=n2" in msg
    assert "role=丙" in msg
    assert "role=甲" not in msg  # 有 target 的不进骨架
    assert "role=丁" not in msg  # 无写盘 deliverable 不进骨架
    assert "有目标正文勿泄露" not in msg
    assert "缺目标的长任务说明不应出现" not in msg
    assert "也缺写盘" not in msg
    assert "纯对话不进拒名单" not in msg
    # 同源组装函数契约
    assert msg == format_bare_chat_no_target_error(
        [
            {
                "id": "n2",
                "role": "乙",
                "task": "缺目标的长任务说明不应出现",
                "deliverable": {"form": "files"},
            },
            {
                "role": "丙",
                "task": "也缺写盘",
                "deliverable": {"requires_files": True},
            },
        ]
    )


def test_gate_bare_chat_allows_with_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[
                {
                    "role": "工",
                    "task": "写",
                    "target_folder_id": "proj_a",
                    "deliverable": {"form": "files"},
                }
            ],
        )
        is None
    )


def test_gate_bare_chat_allows_when_all_have_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[
                {"role": "甲", "task": "a", "target_folder_id": "p1"},
                {"role": "乙", "task": "b", "target_folder_id": "p2"},
            ],
        )
        is None
    )


def test_gate_birth_allows_omit_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id="birth",
            tasks_raw=[
                {"role": "工", "task": "写", "deliverable": {"form": "files"}}
            ],
        )
        is None
    )


def test_gate_bare_inherits_default_target():
    assert (
        gate_bare_chat_requires_target(
            session_folder_id=None,
            tasks_raw=[
                {"role": "子", "task": "续", "deliverable": {"form": "files"}}
            ],
            default_target_folder_id="parent_desk",
        )
        is None
    )


def test_turn_target_desk_hint_single_then_clear():
    from agentcore.tools.protocol import TurnTargetDeskHint

    hint = TurnTargetDeskHint()
    hint.note_folder("  a  ")
    assert hint.folder_id == "a"
    hint.note_folder("a")
    assert hint.folder_id == "a"
    hint.note_folder("b")
    assert hint.folder_id is None


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
        return "TARGET_PROMPT", False, False

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
async def test_load_target_folder_binding_db_unreachable_raises_structured(
    monkeypatch: pytest.MonkeyPatch,
):
    """PG down → TargetDesktopError with stable service-unavailable copy; never forge local_binding."""
    from sqlalchemy.exc import OperationalError

    from agentcore.db.errors import DATABASE_UNAVAILABLE_MESSAGE

    cause = OSError(1225, "远程计算机拒绝网络连接")
    cause.winerror = 1225  # type: ignore[attr-defined]
    err = OperationalError("SELECT 1", {}, cause)
    err.__cause__ = cause

    class _CM:
        async def __aenter__(self) -> object:
            raise err

        async def __aexit__(self, *args: object) -> None:
            return None

    import agentcore.db.base as db_base

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _CM())

    with pytest.raises(TargetDesktopError, match="服务暂时不可用") as caught:
        await load_target_folder_binding(folder_id="any-folder", user_id="u1")

    msg = caught.value.message
    assert DATABASE_UNAVAILABLE_MESSAGE in msg
    assert "请确认数据库" not in msg
    assert "WinError" not in msg
    assert "1225" not in msg


@pytest.mark.asyncio
async def test_apply_target_desktop_db_unreachable_surfaces_structured_error(
    monkeypatch: pytest.MonkeyPatch,
):
    """delegate 换桌: connectivity failure is structured, not bare OS connection code."""
    from sqlalchemy.exc import OperationalError

    from agentcore.db.errors import DATABASE_UNAVAILABLE_MESSAGE

    err = OperationalError("SELECT 1", {}, ConnectionRefusedError("refused"))

    class _CM:
        async def __aenter__(self) -> object:
            raise err

        async def __aexit__(self, *args: object) -> None:
            return None

    import agentcore.db.base as db_base

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _CM())

    ctx = ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=SimpleNamespace(location="server"),  # type: ignore[arg-type]
        user_id="u1",
        conversation_id="c1",
    )
    with pytest.raises(TargetDesktopError) as caught:
        await apply_target_desktop(
            target_folder_id="cloud-or-local",
            session_folder_id="birth",
            env_system_prompt="P",
            base_tool_context=ctx,
            worker_tools=ToolRegistry(),
            sink=MagicMock(),
            local_root_claims=None,
        )

    assert DATABASE_UNAVAILABLE_MESSAGE in caught.value.message
    assert "不存在或无权" not in caught.value.message

@pytest.mark.asyncio
async def test_load_target_folder_binding_cloud_folder_has_no_local_binding(
    monkeypatch: pytest.MonkeyPatch,
):
    """Cloud row → local_binding is None (must not invent a local desk)."""
    folder = SimpleNamespace(
        id="cloud-1",
        name="Cloud Desk",
        local_root_id=None,
        local_subpath=None,
    )

    class _Repo:
        def __init__(self, session: object) -> None:
            del session

        async def get_by_id(self, folder_id: str, *, user_id: str) -> object:
            assert folder_id == "cloud-1"
            assert user_id == "u1"
            return folder

    class _CM:
        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, *args: object) -> None:
            return None

    import agentcore.db.base as db_base
    import agentcore.db.repositories as repos

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _CM())
    monkeypatch.setattr(repos, "FolderRepository", _Repo)

    binding = await load_target_folder_binding(folder_id="cloud-1", user_id="u1")
    assert binding is not None
    assert binding.folder_id == "cloud-1"
    assert binding.local_binding is None


@pytest.mark.asyncio
async def test_load_target_folder_binding_missing_stays_none(
    monkeypatch: pytest.MonkeyPatch,
):
    """Business miss stays None (apply_target_desktop → 不存在或无权), not DB copy."""

    class _Repo:
        def __init__(self, session: object) -> None:
            del session

        async def get_by_id(self, folder_id: str, *, user_id: str) -> None:
            del folder_id, user_id
            return None

    class _CM:
        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, *args: object) -> None:
            return None

    import agentcore.db.base as db_base
    import agentcore.db.repositories as repos

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _CM())
    monkeypatch.setattr(repos, "FolderRepository", _Repo)

    assert await load_target_folder_binding(folder_id="missing", user_id="u1") is None


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
        return "LOCAL_B_PROMPT", False, False

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
        return "CLOUD_PROMPT", False, False

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
async def test_delegate_execute_bare_chat_auto_provisions(monkeypatch):
    """DelegateTool.execute：裸聊写盘缺 target → 静默建云桌并过闸。"""
    from agentcore.llm.provider.protocol import LLMProvider
    from agentcore.runtime.events import EventSink
    from agentcore.tools.builtin.delegate.tool import DelegateTool

    class _DummyLLM(LLMProvider):
        async def complete(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise NotImplementedError

        async def stream(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise NotImplementedError
            yield  # pragma: no cover

    async def _fake_create(*, user_id: str, name: str) -> dict:
        return {"id": "auto_desk", "name": name, "mode": "cloud"}

    monkeypatch.setattr(
        "agentcore.tools.builtin.projects.create_cloud_folder",
        _fake_create,
    )
    monkeypatch.setattr(
        "agentcore.runtime.delegate.target_desktop._load_conversation_title",
        AsyncMock(return_value="会话标题甲"),
    )

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
        user_message="用户消息预览应被标题覆盖",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=ctx,
        folder_id=None,
        captain_run_id="CEO",
    )
    provisioned: list[dict[str, object]] = []

    import agentcore.runtime.delegate.target_desktop as td_mod

    _orig_info = td_mod.logger.info

    def _capture(event: str, **fields: object) -> None:
        if event == "delegate.auto_cloud_desk_provisioned":
            provisioned.append(fields)
        _orig_info(event, **fields)

    monkeypatch.setattr(td_mod.logger, "info", _capture)

    result = await t.execute(
        {
            "tasks": [
                {
                    "role": "工",
                    "task": "写 README",
                    "deliverable": {"form": "files"},
                }
            ]
        },
        ctx,
    )
    err = result.error or ""
    assert not err.startswith(NO_TARGET_SCRATCH_GATE_MSG)
    assert ctx.turn_target_desk.folder_id == "auto_desk"
    assert provisioned and provisioned[0].get("folder_id") == "auto_desk"
    assert provisioned[0].get("name") == "会话标题甲"
    assert provisioned[0].get("conversation_untouched") is True


@pytest.mark.asyncio
async def test_ensure_bare_chat_auto_cloud_desk_skips_when_hint_exists(monkeypatch):
    from agentcore.runtime.delegate.target_desktop import ensure_bare_chat_auto_cloud_desk
    from agentcore.tools.protocol import TurnTargetDeskHint

    creates: list[str] = []

    async def _fake_create(*, user_id: str, name: str) -> dict:
        creates.append(name)
        return {"id": "x", "name": name}

    monkeypatch.setattr(
        "agentcore.tools.builtin.projects.create_cloud_folder",
        _fake_create,
    )
    hint = TurnTargetDeskHint()
    hint.note_folder("existing")
    out = await ensure_bare_chat_auto_cloud_desk(
        session_folder_id=None,
        tasks_raw=[{"role": "工", "deliverable": {"form": "files"}}],
        default_target_folder_id="existing",
        turn_target_desk=hint,
        user_id="u1",
        user_message="msg",
    )
    assert out is None
    assert creates == []
    assert hint.auto_cloud_provisioned is False


@pytest.mark.asyncio
async def test_ensure_bare_chat_auto_cloud_desk_skips_prose(monkeypatch):
    from agentcore.runtime.delegate.target_desktop import ensure_bare_chat_auto_cloud_desk
    from agentcore.tools.protocol import TurnTargetDeskHint

    creates: list[str] = []

    async def _fake_create(*, user_id: str, name: str) -> dict:
        creates.append(name)
        return {"id": "x", "name": name}

    monkeypatch.setattr(
        "agentcore.tools.builtin.projects.create_cloud_folder",
        _fake_create,
    )
    hint = TurnTargetDeskHint()
    out = await ensure_bare_chat_auto_cloud_desk(
        session_folder_id=None,
        tasks_raw=[{"role": "客", "deliverable": {"form": "prose"}}],
        default_target_folder_id=None,
        turn_target_desk=hint,
        user_id="u1",
        user_message="闲聊",
    )
    assert out is None
    assert creates == []
