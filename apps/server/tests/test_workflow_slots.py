"""工作流槽位：占位符 / 默认值 = 原轮原值 / 按需抽槽（失败一律回落成「没有槽位」）。

抽槽是用户第一次要复用这套拆法时的一次背景模型调用（``suggest-slots`` 端点），不在保存路径
上。这里一律用合成回复 + mock，不真跑 LLM。
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agentcore.api.schemas.workflows import (
    CreateWorkflowRequest,
    RunWorkflowRequest,
    WorkflowDefinitionModel,
)
from agentcore.workflows import slot_extract
from agentcore.workflows.definition import (
    expand_workflow_to_tasks,
    validate_workflow_definition,
)
from agentcore.workflows.slot_extract import (
    SlotCandidate,
    parameterize_definition,
    suggest_slots_for_definition,
)

_TOPIC = "Notion 的协作功能定价"
# 服务端权威的固化来源：落在 ``user_workflows.source`` 列上，不在 definition 里。
_SOURCE = {"kind": "turn", "conversation_id": "conv-1", "message_id": "msg-1"}


def _plain_definition() -> dict:
    """一轮调研 → 写作，任务描述里写死了这一次的主题。"""
    return {
        "nodes": [
            {
                "id": "research",
                "kind": "agent_step",
                "role": "研究员",
                "task": f"调研{_TOPIC}，产出要点清单",
            },
            {
                "id": "write",
                "kind": "agent_step",
                "role": "写手",
                "task": f"根据调研写一篇关于{_TOPIC}的简报",
            },
        ],
        "edges": [{"from": "research", "to": "write"}],
    }


def _slotted_definition() -> dict:
    return {
        "nodes": [
            {
                "id": "research",
                "kind": "agent_step",
                "role": "研究员",
                "task": "调研{{topic}}，产出要点清单",
            },
            {
                "id": "write",
                "kind": "agent_step",
                "role": "写手",
                "task": "根据调研写一篇关于{{topic}}的简报",
            },
        ],
        "edges": [{"from": "research", "to": "write"}],
        "slots": [{"key": "topic", "label": "主题", "default": _TOPIC}],
    }


def _tasks(definition: dict, **kw) -> dict[str, dict]:
    return {t["id"]: t for t in expand_workflow_to_tasks(definition, **kw)}


# --- 展开：默认值 / 覆盖值 / 无 slots ---------------------------------------------


def test_no_slots_definition_expands_exactly_as_before():
    """没有 slots 的工作流一个字符都不该被改写——占位符形状的文本也当普通文本。"""
    definition = _plain_definition()
    definition["nodes"][0]["task"] = "调研 {{topic}} 的定价"
    tasks = _tasks(definition)
    assert tasks["research"]["task"] == "调研 {{topic}} 的定价"
    assert tasks["write"]["task"] == f"根据调研写一篇关于{_TOPIC}的简报"


def test_defaults_reproduce_the_original_turn_verbatim():
    """不填任何覆盖值 = 原样再跑一次：展开结果必须与固化前逐字相同。"""
    assert _tasks(_slotted_definition()) == _tasks(_plain_definition())


def test_override_swaps_the_input_in_every_step_that_uses_it():
    tasks = _tasks(_slotted_definition(), slot_values={"topic": "Figma 的团队版"})
    assert tasks["research"]["task"] == "调研Figma 的团队版，产出要点清单"
    assert tasks["write"]["task"] == "根据调研写一篇关于Figma 的团队版的简报"


def test_blank_override_falls_back_to_the_default():
    """输入框清空 = 回到原值，不是把占位符换成空串。"""
    tasks = _tasks(_slotted_definition(), slot_values={"topic": "   "})
    assert tasks["research"]["task"] == f"调研{_TOPIC}，产出要点清单"


def test_unknown_override_keys_and_undeclared_placeholders_are_left_alone():
    definition = _slotted_definition()
    definition["nodes"][1]["task"] = "写关于{{topic}}的简报，风格见 {{style}}"
    tasks = _tasks(definition, slot_values={"topic": "A", "nosuch": "B"})
    assert tasks["write"]["task"] == "写关于A的简报，风格见 {{style}}"


def test_slots_survive_definition_validation_and_the_api_model():
    """契约：definition 顶层可选 slots——校验放行，落库时不能被 schema 吃掉。"""
    definition = _slotted_definition()
    assert validate_workflow_definition(definition) == []

    body = CreateWorkflowRequest(name="简报流", definition=definition)
    stored = body.definition.payload()
    assert stored["slots"] == [{"key": "topic", "label": "主题", "default": _TOPIC}]
    assert WorkflowDefinitionModel(**_plain_definition()).payload()["slots"] == []


@pytest.mark.parametrize(
    "slots, expected",
    [
        ("nope", "slots 必须是数组"),
        ([{"key": "Topic", "label": "主题"}], "key"),
        ([{"key": "topic", "label": ""}], "label"),
        ([{"key": "topic", "label": "主题"}, {"key": "topic", "label": "别名"}], "重复"),
    ],
)
def test_broken_slots_are_reported_not_silently_dropped(slots, expected):
    definition = {**_plain_definition(), "slots": slots}
    assert any(expected in e for e in validate_workflow_definition(definition))


# --- 抽槽（纯逻辑：模型给候选 → 代码验证并改写） -----------------------------------


def test_extraction_replaces_the_verbatim_value_in_every_step():
    definition, slots = parameterize_definition(
        _plain_definition(),
        [SlotCandidate(key="topic", label="主题", value=_TOPIC)],
    )
    assert slots == [{"key": "topic", "label": "主题", "default": _TOPIC}]
    assert definition["nodes"][0]["task"] == "调研{{topic}}，产出要点清单"
    assert definition["nodes"][1]["task"] == "根据调研写一篇关于{{topic}}的简报"
    # 默认值 = 原值：展开回去与原 definition 逐字一致。
    assert _tasks(definition) == _tasks(_plain_definition())


@pytest.mark.parametrize(
    "candidate",
    [
        # 模型编的：原文里根本没有这段。
        SlotCandidate(key="topic", label="主题", value="Slack 的企业版定价"),
        # key 不合法。
        SlotCandidate(key="Topic Key", label="主题", value=_TOPIC),
        # 太短：换掉只会到处误伤。
        SlotCandidate(key="topic", label="主题", value="研"),
        # 自带占位符语法。
        SlotCandidate(key="topic", label="主题", value="{{x}}"),
    ],
)
def test_garbage_candidates_degrade_to_no_slots(candidate):
    original = _plain_definition()
    definition, slots = parameterize_definition(original, [candidate])
    assert slots == []
    assert definition == original


def test_definition_that_already_uses_braces_is_left_unparameterized():
    """原文自带双花括号：再插占位符不可逆，整份让路。"""
    original = _plain_definition()
    original["nodes"][0]["task"] = "按 {{schema}} 调研" + _TOPIC
    definition, slots = parameterize_definition(
        original, [SlotCandidate(key="topic", label="主题", value=_TOPIC)]
    )
    assert slots == []
    assert definition == original


def test_nested_values_keep_the_roundtrip_exact():
    """长片段先替换，短的若已被吃掉就丢弃——展开回去仍须逐字复现原文。"""
    original = _plain_definition()
    definition, slots = parameterize_definition(
        original,
        [
            SlotCandidate(key="product", label="产品", value="Notion"),
            SlotCandidate(key="topic", label="主题", value=_TOPIC),
        ],
    )
    assert [s["key"] for s in slots] == ["topic"]
    assert _tasks(definition) == _tasks(original)


def test_extraction_caps_the_slot_count():
    task = "、".join(f"要点{i}" for i in range(10))
    original = {
        "nodes": [{"id": "a", "kind": "agent_step", "role": "研究员", "task": task}],
        "edges": [],
    }
    _definition, slots = parameterize_definition(
        original,
        [SlotCandidate(key=f"k{i}", label=f"点{i}", value=f"要点{i}") for i in range(10)],
    )
    assert len(slots) == 6


# --- 抽槽（模型调用：失败一律回落成「没有槽位」） -----------------------------------


async def test_successful_extraction_rewrites_the_definition(monkeypatch):
    reply = (
        '```json\n{"slots":[{"key":"topic","label":"主题",'
        f'"value":"{_TOPIC}"}}]}}\n```'
    )
    monkeypatch.setattr(slot_extract, "_ask_model", AsyncMock(return_value=reply))

    definition, slots = await suggest_slots_for_definition(
        _plain_definition(), user_id="u1"
    )
    assert slots == [{"key": "topic", "label": "主题", "default": _TOPIC}]
    assert definition["slots"] == slots
    assert definition["nodes"][0]["task"] == "调研{{topic}}，产出要点清单"


@pytest.mark.parametrize(
    "outcome",
    [
        AsyncMock(side_effect=TimeoutError("upstream stalled")),
        AsyncMock(side_effect=RuntimeError("provider exploded")),
        AsyncMock(return_value=""),
        AsyncMock(return_value="抱歉，我无法完成这个请求"),
        AsyncMock(return_value='{"slots":[{"key":"topic","value":"根本没出现过的主题"}]}'),
        AsyncMock(return_value='{"slots":"这不是数组"}'),
    ],
)
async def test_any_extraction_failure_returns_the_untouched_definition(
    monkeypatch, outcome
):
    monkeypatch.setattr(slot_extract, "_ask_model", outcome)
    original = _plain_definition()

    definition, slots = await suggest_slots_for_definition(original, user_id="u1")
    assert slots == []
    assert definition == original
    assert "slots" not in definition


async def test_extraction_skipped_when_there_is_nothing_to_parameterize(monkeypatch):
    called = AsyncMock(return_value="")
    monkeypatch.setattr(slot_extract, "_ask_model", called)

    empty = {"nodes": [], "edges": []}
    assert await suggest_slots_for_definition(empty, user_id="u1") == (empty, [])
    called.assert_not_awaited()


async def test_missing_credentials_degrade_to_no_slots(monkeypatch):
    """无凭据 / 配额耗尽：``run_background_llm`` 给 None，照常拿回一份无槽位 definition。"""
    monkeypatch.setattr(
        "agentcore.billing.gate.run_background_llm", AsyncMock(return_value=None)
    )
    original = _plain_definition()
    assert await suggest_slots_for_definition(original, user_id="u1") == (original, [])


# --- 保存路由：不调模型，存的就是原轮原文 -------------------------------------------


class _FakeWorkflowRepo:
    """``update`` 不收 ``source``（真 repo 也不收）——来源创建后没有任何路径能改。"""

    def __init__(self) -> None:
        self.rows: list[SimpleNamespace] = []
        self.updates = 0

    async def find_by_turn_source(self, *, user_id, conversation_id, message_id):
        for row in self.rows:
            source = row.source or {}
            if row.user_id != user_id or source.get("kind") != "turn":
                continue
            if (
                source.get("conversation_id") == conversation_id
                and source.get("message_id") == message_id
            ):
                return row
        return None

    async def get_by_id(self, workflow_id: str, *, user_id: str | None = None):
        for row in self.rows:
            if row.id == workflow_id and (user_id is None or row.user_id == user_id):
                return row
        return None

    async def create(self, *, user_id, name, definition, description=None, source=None):
        now = datetime(2026, 8, 13, tzinfo=UTC)
        row = SimpleNamespace(
            id=f"wf-{len(self.rows) + 1}",
            user_id=user_id,
            name=name,
            description=description,
            definition=definition,
            source=dict(source) if source else None,
            version=1,
            created_at=now,
            updated_at=now,
        )
        self.rows.append(row)
        return row

    async def update(
        self, workflow_id, *, user_id, name=None, description=..., definition=None
    ):
        row = await self.get_by_id(workflow_id, user_id=user_id)
        if row is None:
            return None
        self.updates += 1
        if name is not None:
            row.name = name
        if description is not ...:
            row.description = description
        if definition is not None:
            row.definition = dict(definition)
        row.version += 1
        return row


async def _save(repo: _FakeWorkflowRepo):
    from agentcore.api.routes.conversations.save_as_workflow import save_turn_as_workflow
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.serialize import plan_snapshot_fact
    from agentcore.runtime.runs.types import RunSpec

    def _spec(rid: str, role: str, task: str) -> RunSpec:
        return RunSpec(
            run_id=rid,
            task=task,
            role=role,
            agent_id=rid,
            agent_name=role,
            depth=1,
            parent_run_id="captain",
        )

    # 真实铸造形状：``del_<uuid>_<CEO 声明的 tasks[].id>``（反解后才是画布 id）。
    minted = "del_2f1c4a90-0b3d-4c21-9a77-1f0e5b6d8c33"
    plan = RunPlan(
        nodes=[
            _spec(f"{minted}_research", "研究员", f"调研{_TOPIC}，产出要点清单"),
            _spec(f"{minted}_write", "写手", f"根据调研写一篇关于{_TOPIC}的简报"),
        ]
    )
    return await save_turn_as_workflow(
        _SOURCE["conversation_id"],
        _SOURCE["message_id"],
        SimpleNamespace(user_id="u1"),
        body=None,
        conv_repo=SimpleNamespace(
            get_by_id=AsyncMock(return_value=SimpleNamespace(id="conv-1"))
        ),
        msg_repo=SimpleNamespace(
            get_by_id=AsyncMock(
                return_value=SimpleNamespace(id="msg-1", role="assistant")
            )
        ),
        journal_repo=SimpleNamespace(
            load_owned=AsyncMock(return_value=[plan_snapshot_fact(plan).entry()])
        ),
        workflow_repo=repo,
    )


async def test_save_route_never_calls_the_model(monkeypatch):
    """保存 = 「这轮不错先存下来」，不该为一件用户还没想到的事等一次模型调用。"""
    asked = AsyncMock(
        return_value=f'{{"slots":[{{"key":"topic","label":"主题","value":"{_TOPIC}"}}]}}'
    )
    monkeypatch.setattr(slot_extract, "_ask_model", asked)

    saved = await _save(_FakeWorkflowRepo())
    asked.assert_not_awaited()
    assert "slots" not in saved.definition
    stored = {n["id"]: n["task"] for n in saved.definition["nodes"]}
    assert stored["research"] == f"调研{_TOPIC}，产出要点清单"
    assert saved.source.model_dump() == _SOURCE
    assert "source" not in saved.definition


# --- 按需抽槽路由：幂等 / 只认固化来源 / 抽不出来照常能跑 ----------------------------


async def _suggest(repo: _FakeWorkflowRepo, workflow_id: str = "wf-1"):
    from agentcore.api.routes.workflows import suggest_workflow_slots

    return await suggest_workflow_slots(
        workflow_id=workflow_id,
        user=SimpleNamespace(user_id="u1"),
        repo=repo,
    )


def _reply(**values: str) -> str:
    items = ",".join(
        f'{{"key":"{k}","label":"主题","value":"{v}"}}' for k, v in values.items()
    )
    return f'{{"slots":[{items}]}}'


async def _saved_then_suggested(monkeypatch, reply: str):
    """走一遍真实时序：先保存（原文落库），再按需抽槽（写回）。"""
    monkeypatch.setattr(slot_extract, "_ask_model", AsyncMock(return_value=reply))
    repo = _FakeWorkflowRepo()
    saved = await _save(repo)
    return repo, saved, await _suggest(repo)


async def test_suggest_writes_placeholders_back_and_defaults_reproduce_the_turn(
    monkeypatch,
):
    """抽到了就落库：以后再跑不用重抽，且不填覆盖值仍逐字复现原轮任务描述。"""
    repo, saved, out = await _saved_then_suggested(monkeypatch, _reply(topic=_TOPIC))

    assert out.definition["slots"] == [
        {"key": "topic", "label": "主题", "default": _TOPIC}
    ]
    assert out.definition["nodes"][0]["task"] == "调研{{topic}}，产出要点清单"
    # 写回 definition 不碰来源：它在列上，抽槽这条写路径根本传不了它。
    assert out.source.model_dump() == _SOURCE
    assert "可替换槽位" in (out.description or "")
    # 写回的是同一条记录：前端下次拿到的就是这份带槽位的 definition。
    assert repo.rows[0].definition["slots"] == out.definition["slots"]

    # 不填 = 原样复跑（与写回前逐字相同）；填了 = 每个用到它的步骤一起换。
    assert _tasks(out.definition) == _tasks(saved.definition)
    swapped = _tasks(out.definition, slot_values={"topic": "Figma 的团队版"})
    assert swapped["research"]["task"] == "调研Figma 的团队版，产出要点清单"
    assert swapped["write"]["task"] == "根据调研写一篇关于Figma 的团队版的简报"


async def test_suggest_is_idempotent_once_slots_exist(monkeypatch):
    """已经有槽位就直接返回：第二次点「跑一次」不该再烧一次模型调用。"""
    repo, _saved, first = await _saved_then_suggested(monkeypatch, _reply(topic=_TOPIC))
    writes = repo.updates

    asked = AsyncMock(return_value=_reply(product="Notion"))
    monkeypatch.setattr(slot_extract, "_ask_model", asked)
    again = await _suggest(repo)

    asked.assert_not_awaited()
    assert repo.updates == writes
    assert again.definition == first.definition
    assert again.version == first.version


async def test_suggest_skips_workflows_not_folded_from_a_turn(monkeypatch):
    """官方模板复制来的自带槽位、手画的归用户管——不替他们改写任务描述。"""
    asked = AsyncMock(return_value=_reply(topic=_TOPIC))
    monkeypatch.setattr(slot_extract, "_ask_model", asked)
    repo = _FakeWorkflowRepo()
    handmade = _plain_definition()
    await repo.create(user_id="u1", name="手画的", definition=handmade)

    out = await _suggest(repo)
    asked.assert_not_awaited()
    assert repo.updates == 0
    assert out.definition == handmade


async def test_a_forged_definition_source_cannot_buy_slot_extraction(monkeypatch):
    """来源读的是列：客户端在画布里塞一个 ``source``，骗不到这次模型调用。

    抽槽会拿用户的任务描述去调模型改写，手画的工作流冒充固化来源就是替他做他没要过的
    决定——这正是把来源搬出 definition 的原因之一。
    """
    asked = AsyncMock(return_value=_reply(topic=_TOPIC))
    monkeypatch.setattr(slot_extract, "_ask_model", asked)
    repo = _FakeWorkflowRepo()
    forged = {**_plain_definition(), "source": dict(_SOURCE)}
    await repo.create(user_id="u1", name="手画的", definition=forged)

    out = await _suggest(repo)
    asked.assert_not_awaited()
    assert repo.updates == 0
    assert out.source is None
    assert "slots" not in out.definition


@pytest.mark.parametrize(
    "outcome",
    [
        AsyncMock(side_effect=TimeoutError("upstream stalled")),
        AsyncMock(side_effect=RuntimeError("provider exploded")),
        AsyncMock(return_value=""),
        AsyncMock(return_value='{"slots":[{"key":"topic","value":"根本没出现过的主题"}]}'),
    ],
)
async def test_suggest_falls_back_to_the_definition_it_was_called_with(
    monkeypatch, outcome
):
    """抽不出来 = 「没有槽位」而不是报错：前端照常直接跑，definition 一个字符没动。"""
    monkeypatch.setattr(slot_extract, "_ask_model", outcome)
    repo = _FakeWorkflowRepo()
    saved = await _save(repo)
    before = dict(saved.definition)

    out = await _suggest(repo)
    assert "slots" not in out.definition
    assert out.definition == before
    assert out.version == saved.version
    assert repo.updates == 0


async def test_suggest_404s_on_someone_elses_workflow(monkeypatch):
    from agentcore.core.errors import NotFoundError

    asked = AsyncMock(return_value=_reply(topic=_TOPIC))
    monkeypatch.setattr(slot_extract, "_ask_model", asked)
    repo = _FakeWorkflowRepo()
    await repo.create(
        user_id="u2", name="别人的", definition=_plain_definition(), source=dict(_SOURCE)
    )

    with pytest.raises(NotFoundError):
        await _suggest(repo)
    asked.assert_not_awaited()


# --- 跑一次：槽位覆盖值走到 dispatch ------------------------------------------------


async def test_run_route_forwards_slot_overrides(monkeypatch):
    from agentcore.api.routes.workflows import run_workflow

    dispatch = AsyncMock(return_value="conv-1")
    monkeypatch.setattr(
        "agentcore.api.routes.workflows.dispatch_workflow_run", dispatch
    )
    repo = SimpleNamespace(
        get_by_id=AsyncMock(
            return_value=SimpleNamespace(
                id="wf-1", version=3, definition=_slotted_definition(), name="简报流"
            )
        )
    )
    folders = SimpleNamespace(
        get_by_id=AsyncMock(return_value=SimpleNamespace(id="folder-1"))
    )

    await run_workflow(
        workflow_id="wf-1",
        body=RunWorkflowRequest(folder_id="folder-1", slots={"topic": "Figma 的团队版"}),
        user=SimpleNamespace(user_id="u1"),
        folders=folders,
        repo=repo,
    )
    assert dispatch.await_args.kwargs["slot_values"] == {"topic": "Figma 的团队版"}

    await run_workflow(
        workflow_id="wf-1",
        body=RunWorkflowRequest(folder_id="folder-1"),
        user=SimpleNamespace(user_id="u1"),
        folders=folders,
        repo=repo,
    )
    assert dispatch.await_args.kwargs["slot_values"] is None
