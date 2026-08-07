"""RWF-2: workflow run sync credential preflight before spawn."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agentcore.core.errors import BYOKKeyMissingError
from agentcore.core.types import PermissionAxes
from agentcore.llm.credentials import LLMCredentials
from agentcore.workflows import runner as runner_mod


def _ok_definition() -> dict:
    return {
        "nodes": [
            {"id": "a", "kind": "agent_step", "role": "研究员", "task": "调研"},
        ],
        "edges": [],
    }


class _Session:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _patch_dispatch_session(monkeypatch, *, creates: list | None = None):
    creates = creates if creates is not None else []

    class _Folders:
        def __init__(self, session):
            pass

        async def get_by_id(self, folder_id, user_id=None):
            return SimpleNamespace(id=folder_id)

    class _Users:
        def __init__(self, session):
            pass

        async def get_by_id(self, user_id):
            return SimpleNamespace(user_id=user_id)

    class _Convs:
        def __init__(self, session):
            pass

        async def get_by_id(self, conv_id, user_id=None):
            return SimpleNamespace(id=conv_id, folder_id="folder-1")

        async def create(self, **kwargs):
            creates.append(kwargs)
            return SimpleNamespace(id="conv-new")

    class _Cost:
        def __init__(self, session):
            pass

    monkeypatch.setattr(runner_mod, "async_session_factory", lambda: _Session())
    monkeypatch.setattr(runner_mod, "FolderRepository", _Folders)
    monkeypatch.setattr(runner_mod, "UserRepository", _Users)
    monkeypatch.setattr(runner_mod, "ConversationRepository", _Convs)
    monkeypatch.setattr(runner_mod, "CostEventRepository", _Cost)
    monkeypatch.setattr(
        runner_mod,
        "default_permission_axes_for_user",
        AsyncMock(return_value=PermissionAxes()),
    )
    monkeypatch.setattr(
        runner_mod,
        "resolve_account_default_model",
        AsyncMock(
            return_value=SimpleNamespace(
                origin="byok", provider_id="prov-1", model="gpt-test"
            )
        ),
    )
    monkeypatch.setattr(
        runner_mod,
        "resolve_conversation_model_selection",
        AsyncMock(
            return_value=SimpleNamespace(
                origin="byok", provider_id="prov-1", model="gpt-test"
            )
        ),
    )
    return creates


@pytest.mark.asyncio
async def test_dispatch_preflight_missing_key_raises_and_does_not_spawn(monkeypatch):
    creates = _patch_dispatch_session(monkeypatch)
    spawned: list = []

    def fake_spawn(coro):
        spawned.append(coro)
        coro.close()
        return MagicMock(name="task")

    monkeypatch.setattr(runner_mod, "spawn_background", fake_spawn)
    monkeypatch.setattr(
        runner_mod,
        "preflight_resolved_llm_credentials",
        AsyncMock(side_effect=BYOKKeyMissingError("跑工作流需要可用的模型凭证")),
    )

    with pytest.raises(BYOKKeyMissingError, match="模型凭证"):
        await runner_mod.dispatch_workflow_run(
            user_id="user-1",
            workflow_id="wf-1",
            workflow_version=1,
            definition=_ok_definition(),
            folder_id="folder-1",
            workflow_name="质检",
        )

    assert spawned == []
    assert creates == []


@pytest.mark.asyncio
async def test_dispatch_success_spawns_with_credentials_after_create(monkeypatch):
    creates = _patch_dispatch_session(monkeypatch)
    spawned: list = []
    creds = LLMCredentials(
        api_key="sk-test",
        base_url="https://example/v1",
        default_model="gpt-test",
        source="user",
        provider_id="prov-1",
    )

    def fake_spawn(coro):
        spawned.append(coro)
        coro.close()
        return MagicMock(name="task")

    monkeypatch.setattr(runner_mod, "spawn_background", fake_spawn)
    monkeypatch.setattr(
        runner_mod,
        "preflight_resolved_llm_credentials",
        AsyncMock(return_value=creds),
    )

    conv_id = await runner_mod.dispatch_workflow_run(
        user_id="user-1",
        workflow_id="wf-1",
        workflow_version=2,
        definition=_ok_definition(),
        folder_id="folder-1",
        workflow_name="质检",
        note="补充",
    )

    assert conv_id == "conv-new"
    assert len(creates) == 1
    assert creates[0]["mode"] == "workflow"
    assert len(spawned) == 1


@pytest.mark.asyncio
async def test_dispatch_passes_preflight_credentials_into_job(monkeypatch):
    _patch_dispatch_session(monkeypatch)
    job_kwargs: list[dict] = []
    creds = LLMCredentials(
        api_key="sk-test",
        base_url="https://example/v1",
        default_model="gpt-test",
        source="user",
        provider_id="prov-1",
    )

    def fake_spawn(coro):
        coro.close()
        return MagicMock(name="task")

    monkeypatch.setattr(runner_mod, "spawn_background", fake_spawn)
    monkeypatch.setattr(runner_mod, "preflight_resolved_llm_credentials", AsyncMock(return_value=creds))

    real_job = runner_mod.run_workflow_job

    def capturing_job(**kwargs):
        job_kwargs.append(kwargs)
        return real_job(**kwargs)

    monkeypatch.setattr(runner_mod, "run_workflow_job", capturing_job)

    await runner_mod.dispatch_workflow_run(
        user_id="user-1",
        workflow_id="wf-1",
        workflow_version=1,
        definition=_ok_definition(),
        folder_id="folder-1",
    )

    assert len(job_kwargs) == 1
    assert job_kwargs[0]["llm_credentials"] is creds


@pytest.mark.asyncio
async def test_dispatch_existing_conversation_skips_create_on_preflight_fail(monkeypatch):
    creates = _patch_dispatch_session(monkeypatch)
    spawned: list = []

    def fake_spawn(coro):
        spawned.append(coro)
        coro.close()
        return MagicMock(name="task")

    monkeypatch.setattr(runner_mod, "spawn_background", fake_spawn)
    monkeypatch.setattr(
        runner_mod,
        "preflight_resolved_llm_credentials",
        AsyncMock(side_effect=BYOKKeyMissingError("missing")),
    )

    with pytest.raises(BYOKKeyMissingError):
        await runner_mod.dispatch_workflow_run(
            user_id="user-1",
            workflow_id="wf-1",
            workflow_version=1,
            definition=_ok_definition(),
            folder_id="folder-1",
            conversation_id="conv-existing",
        )

    assert spawned == []
    assert creates == []


@pytest.mark.asyncio
async def test_run_workflow_route_propagates_byok_missing(monkeypatch):
    """Route must not swallow preflight errors into 200 / ValidationError."""
    from agentcore.api.routes.workflows import run_workflow
    from agentcore.api.schemas.workflows import RunWorkflowRequest

    repo = AsyncMock()
    repo.get_by_id = AsyncMock(
        return_value=SimpleNamespace(
            id="wf-1",
            version=1,
            definition=_ok_definition(),
            name="质检",
        )
    )
    folders = AsyncMock()
    folders.get_by_id = AsyncMock(return_value=SimpleNamespace(id="folder-1"))
    monkeypatch.setattr(
        "agentcore.api.routes.workflows.dispatch_workflow_run",
        AsyncMock(side_effect=BYOKKeyMissingError("跑工作流需要可用的模型凭证")),
    )

    with pytest.raises(BYOKKeyMissingError, match="模型凭证"):
        await run_workflow(
            workflow_id="wf-1",
            body=RunWorkflowRequest(folder_id="folder-1"),
            user=SimpleNamespace(user_id="user-1"),
            folders=folders,
            repo=repo,
        )
