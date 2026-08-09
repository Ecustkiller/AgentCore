"""Harvest closing turn must resolve credentials like a normal chat turn."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.core.errors import BYOKKeyMissingError
from agentcore.llm.credentials import LLMCredentials
from agentcore.runtime.coordination.session import (
    CoordinationSession,
    clear_active_coordination,
    set_active_coordination,
)


@pytest.fixture(autouse=True)
def _clean_coordination():
    clear_active_coordination()
    yield
    clear_active_coordination()


def _session(execution_id: str = "exec-h", conversation_id: str = "conv-h") -> CoordinationSession:
    s = CoordinationSession(
        execution_id=execution_id,
        total_workers=1,
        conversation_id=conversation_id,
    )
    s.turn_attached = False
    return s


@pytest.mark.asyncio
async def test_harvest_closing_passes_preflight_credentials_to_run():
    """Regression: llm_credentials=None forced the revoked platform key path."""
    import agentcore.conversation.execution_harvest as eh

    session = _session()
    set_active_coordination(session)
    byok = LLMCredentials(
        api_key="user-key",
        base_url="https://api.example/v1",
        source="user",
        provider_id="prov-1",
    )
    conv = SimpleNamespace(user_id="user-1", folder_id=None, id="conv-h")
    user = SimpleNamespace(user_id="user-1")
    selection = SimpleNamespace(origin="byok", provider_id="prov-1", model="deepseek-v4-flash")

    db_cm = MagicMock()
    db_cm.__aenter__ = AsyncMock(return_value=MagicMock())
    db_cm.__aexit__ = AsyncMock(return_value=None)

    captured: dict = {}

    async def _capture_run(**kwargs):
        captured["llm_credentials"] = kwargs.get("llm_credentials")

    with (
        patch.object(eh, "async_session_factory", return_value=db_cm),
        patch.object(eh, "ConversationRepository") as conv_repo_cls,
        patch.object(eh, "UserRepository") as user_repo_cls,
        patch.object(eh, "CostEventRepository"),
        patch.object(eh, "BoardRepository") as board_repo_cls,
        patch.object(eh, "resolve_conversation_model_selection", AsyncMock(return_value=selection)),
        patch.object(eh, "preflight_llm_credentials", AsyncMock(return_value=byok)),
        patch.object(eh, "resolve_local_binding", AsyncMock(return_value=None)),
        patch.object(eh, "resolve_profile_set", AsyncMock(return_value=None)),
        patch.object(eh, "resolve_memory_enabled", AsyncMock(return_value=True)),
        patch.object(eh, "resolve_conversation_history_access", AsyncMock(return_value=True)),
        patch.object(eh, "resolve_permission_axes", AsyncMock(return_value=None)),
        patch.object(eh, "load_chat_context", AsyncMock(return_value=[])),
        patch.object(eh, "build_turn_backend", AsyncMock(return_value=MagicMock())),
        patch.object(eh, "run_and_persist", new=_capture_run),
        patch.object(eh, "notify_user", AsyncMock()),
        patch("agentcore.db.repositories.MessageRepository") as msg_repo_cls,
        patch.object(eh.turn_runs, "get", return_value=None),
        patch.object(eh.turn_runs, "register"),
    ):
        conv_repo_cls.return_value.get_by_id_unscoped = AsyncMock(return_value=conv)
        user_repo_cls.return_value.get_by_id = AsyncMock(return_value=user)
        board_repo_cls.return_value.get_by_conversation_id = AsyncMock(return_value=None)
        msg_repo_cls.return_value.create = AsyncMock()

        await eh.run_harvest_closing_turn(
            conversation_id="conv-h",
            execution_id="exec-h",
        )

    assert captured["llm_credentials"] is byok
    assert captured["llm_credentials"].source == "user"


@pytest.mark.asyncio
async def test_harvest_closing_persists_fallback_when_preflight_refuses():
    """A1: quota/BYOK refuse → push existing synthesis without LLM turn."""
    import agentcore.conversation.execution_harvest as eh

    session = _session("exec-refuse", "conv-refuse")
    session.update_draft("## 架构结论\n模块 A 依赖 B。")
    session.workspace_channel_dead = True
    set_active_coordination(session)
    conv = SimpleNamespace(user_id="user-1", folder_id=None, id="conv-refuse")
    user = SimpleNamespace(user_id="user-1")
    selection = SimpleNamespace(origin="byok", provider_id=None, model="m")

    db_cm = MagicMock()
    db_cm.__aenter__ = AsyncMock(return_value=MagicMock())
    db_cm.__aexit__ = AsyncMock(return_value=None)

    run_mock = AsyncMock()
    msg_create = AsyncMock()
    notify = AsyncMock()

    with (
        patch.object(eh, "async_session_factory", return_value=db_cm),
        patch.object(eh, "ConversationRepository") as conv_repo_cls,
        patch.object(eh, "UserRepository") as user_repo_cls,
        patch.object(eh, "CostEventRepository"),
        patch.object(eh, "resolve_conversation_model_selection", AsyncMock(return_value=selection)),
        patch.object(
            eh,
            "preflight_llm_credentials",
            AsyncMock(side_effect=BYOKKeyMissingError("请先配置 Key")),
        ),
        patch.object(eh, "run_and_persist", new=run_mock),
        patch.object(eh, "notify_user", new=notify),
        patch("agentcore.db.repositories.MessageRepository") as msg_repo_cls,
        patch.object(eh.turn_runs, "get", return_value=None),
    ):
        conv_repo_cls.return_value.get_by_id_unscoped = AsyncMock(return_value=conv)
        user_repo_cls.return_value.get_by_id = AsyncMock(return_value=user)
        msg_repo_cls.return_value.create = msg_create

        await eh.run_harvest_closing_turn(
            conversation_id="conv-refuse",
            execution_id="exec-refuse",
        )

    run_mock.assert_not_called()
    msg_create.assert_called_once()
    kwargs = msg_create.await_args.kwargs
    assert kwargs["role"] == "assistant"
    assert "架构结论" in kwargs["content"]
    assert "本地文件暂时连不上" in kwargs["content"]
    assert "请先配置 Key" in kwargs["content"]
    assert kwargs["metadata"]["origin"] == "execution_harvest_fallback"
    assert kwargs["metadata"]["no_llm"] is True
    notify.assert_awaited()


def test_build_harvest_fallback_prefers_draft_over_terminal():
    import agentcore.conversation.execution_harvest as eh
    from agentcore.runtime.coordination.session import (
        CoordinationEvent,
        CoordinationEventKind,
    )

    session = _session("exec-b", "conv-b")
    session.update_draft("草稿优先")
    session._pending.append(
        CoordinationEvent(
            kind=CoordinationEventKind.ALL_COMPLETED,
            payload={"output": "终端正文不应优先", "completed": 1, "total": 1},
        )
    )
    text = eh.build_harvest_fallback_content(session, kind="success", error_message="额度已满")
    assert "草稿优先" in text
    assert "终端正文" not in text
    assert "额度已满" in text


def test_build_harvest_fallback_uses_terminal_when_no_draft():
    import agentcore.conversation.execution_harvest as eh
    from agentcore.runtime.coordination.session import (
        CoordinationEvent,
        CoordinationEventKind,
    )

    session = _session("exec-t", "conv-t")
    session._pending.append(
        CoordinationEvent(
            kind=CoordinationEventKind.ALL_COMPLETED,
            payload={"output": "## 团队成品\n结论 X", "completed": 2, "total": 2},
        )
    )
    text = eh.build_harvest_fallback_content(session, kind="success")
    assert "结论 X" in text
    assert "本地文件暂时连不上" not in text


def test_build_harvest_fallback_channel_dead_notice_from_flag():
    import agentcore.conversation.execution_harvest as eh
    from agentcore.workspace.limits import CHANNEL_DEAD_USER_VISIBLE

    session = _session("exec-cd", "conv-cd")
    session.workspace_channel_dead = True
    session.update_draft("已有分析")
    text = eh.build_harvest_fallback_content(session, kind="failure")
    assert text.startswith(CHANNEL_DEAD_USER_VISIBLE)
    assert "已有分析" in text
