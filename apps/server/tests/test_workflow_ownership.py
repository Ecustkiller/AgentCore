"""``definition`` 的所有权：客户端整份覆盖，服务端只校验不重建；来源归服务端。

棘轮测试。同一个形状已经出现四次——有人拿一份多方共享的 JSON 文档，按自己知道的字段把它
重建了一遍，别人加的字段就没了（``deliverable`` 的非 form 字段、画布 ``slots``、
``flowToDef`` 重建 ``{nodes,edges}``、后端 PATCH 走 ``model_dump()`` 抹掉 ``source``）。
这里锁死两条：definition 里的未知字段原样透传；来源在列上，画布怎么覆盖都带不走、也伪造
不出来。
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from agentcore.api.routes.workflows import create_workflow, update_workflow
from agentcore.api.schemas.workflows import (
    CreateWorkflowRequest,
    UpdateWorkflowRequest,
)
from agentcore.workflows.definition import validate_workflow_definition
from agentcore.workflows.source import turn_source

_USER = SimpleNamespace(user_id="u1")
_SOURCE = turn_source(conversation_id="conv-1", message_id="msg-1")


def _canvas() -> dict:
    """一份「别人加过字段」的画布：顶层、节点里、槽位里都有服务端不认识的键。"""
    return {
        "nodes": [
            {
                "id": "research",
                "kind": "agent_step",
                "role": "研究员",
                "task": "调研{{topic}}",
                "position": {"x": 120, "y": 40},
                "deliverable": {"form": "notes", "citation_mode": "two_phase"},
            },
            {
                "id": "write",
                "kind": "agent_step",
                "role": "写手",
                "task": "写简报",
                "collapsed": False,
            },
        ],
        "edges": [{"from": "research", "to": "write", "label": "初稿"}],
        "slots": [
            {"key": "topic", "label": "主题", "default": "Notion", "hint": "换个主题复跑"}
        ],
        "viewport": {"zoom": 1.25},
        "canvas_theme": "dark",
    }


class _Repo:
    def __init__(self, *, definition: dict | None = None, source: dict | None = None):
        now = datetime(2026, 8, 13, tzinfo=UTC)
        self.row = SimpleNamespace(
            id="wf-1",
            user_id="u1",
            name="简报流",
            description=None,
            definition=dict(definition or {"nodes": [], "edges": []}),
            source=dict(source) if source else None,
            version=1,
            created_at=now,
            updated_at=now,
        )

    async def create(self, *, user_id, name, definition, description=None, source=None):
        self.row.name = name
        self.row.description = description
        self.row.definition = dict(definition)
        self.row.source = dict(source) if source else None
        return self.row

    async def update(self, workflow_id, *, user_id, name=None, description=..., definition=None):
        if definition is not None:
            self.row.definition = dict(definition)
        self.row.version += 1
        return self.row


async def _patch(repo: _Repo, definition: dict):
    return await update_workflow(
        workflow_id="wf-1",
        body=UpdateWorkflowRequest(definition=definition),
        user=_USER,
        repo=repo,
    )


def test_validation_does_not_care_about_fields_it_does_not_know():
    assert validate_workflow_definition(_canvas()) == []


async def test_create_stores_the_canvas_the_client_sent():
    repo = _Repo()
    out = await create_workflow(
        body=CreateWorkflowRequest(name="简报流", definition=_canvas()),
        user=_USER,
        repo=repo,
    )
    assert out.definition == _canvas()


async def test_patch_keeps_every_field_it_does_not_model():
    """第五次防线：顶层 / 节点里 / 槽位里的未知字段都得原样回来。"""
    repo = _Repo()
    out = await _patch(repo, _canvas())

    assert out.definition == _canvas()
    assert out.definition["viewport"] == {"zoom": 1.25}
    assert out.definition["nodes"][0]["position"] == {"x": 120, "y": 40}
    assert out.definition["nodes"][0]["deliverable"]["citation_mode"] == "two_phase"
    assert out.definition["slots"][0]["hint"] == "换个主题复跑"


async def test_saving_the_canvas_does_not_drop_the_turn_source():
    """在画布里存一次 = 整份覆盖 definition；来源在列上，不跟着走。"""
    repo = _Repo(source=_SOURCE)
    out = await _patch(repo, {"nodes": [], "edges": []})

    assert out.source is not None
    assert out.source.model_dump() == _SOURCE
    assert repo.row.source == _SOURCE


@pytest.mark.parametrize("existing", [None, _SOURCE])
async def test_a_client_supplied_definition_source_is_not_authority(existing):
    """客户端塞进画布的 ``source`` 落不了库：否则手画的能冒充固化来源去骗抽槽。"""
    repo = _Repo(source=existing)
    forged = {
        **_canvas(),
        "source": {"kind": "turn", "conversation_id": "c-x", "message_id": "m-x"},
    }
    out = await _patch(repo, forged)

    assert "source" not in out.definition
    assert "source" not in repo.row.definition
    assert (out.source.model_dump() if out.source else None) == existing
