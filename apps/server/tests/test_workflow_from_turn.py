"""一轮已跑完的协作 → 用户工作流固化（归一 / 清洗 / 幂等 / 422）单测。"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agentcore.api.routes.conversations.save_as_workflow import save_turn_as_workflow
from agentcore.api.schemas.workflows import SaveTurnAsWorkflowRequest
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.serialize import plan_snapshot_fact
from agentcore.runtime.runs.types import Deliverable, RunSpec
from agentcore.workflows.definition import expand_workflow_to_tasks
from agentcore.workflows.from_turn import (
    TurnWorkflowError,
    draft_workflow_from_journal,
    draft_workflow_from_plan,
    turn_ran_debate,
)
from agentcore.workflows.source import is_turn_sourced

CONVERSATION_ID = "conv-1"
MESSAGE_ID = "msg-1"

# 真实铸造形状：``{del|add}_<uuid>_<CEO 声明的 tasks[].id>``。
_DEL = "del_2f1c4a90-0b3d-4c21-9a77-1f0e5b6d8c33"
_ADD = "add_9b2e7d61-4c88-4f0a-8e15-7a3c2d9f4b60"


def _spec(run_id: str, role: str, task: str, **kw) -> RunSpec:
    return RunSpec(
        run_id=run_id,
        task=task,
        role=role,
        agent_id=run_id,
        agent_name=role,
        depth=kw.pop("depth", 1),
        parent_run_id=kw.pop("parent_run_id", "captain"),
        **kw,
    )


def _research_write_plan() -> RunPlan:
    """两人链：调研 → 写作（写作 checkpoint_after，画布上会长出人审门）。"""
    return RunPlan(
        nodes=[
            _spec(f"{_DEL}_research", "研究员", "调研现状"),
            _spec(
                f"{_DEL}_write",
                "写手",
                "根据调研写报告",
                depends_on=[f"{_DEL}_research"],
                checkpoint_after=True,
            ),
        ]
    )


def _journal(*plans: RunPlan) -> list[dict]:
    return [plan_snapshot_fact(p).entry() for p in plans]


def _debate_entry(kind: str = "debate_round_started") -> dict:
    """辩论机制留在 journal 里的痕迹（辩论从不写 plan_snapshot）。"""
    return {"kind": kind, "payload": {"round_no": 1, "focus": "该不该自研"}, "ts": None}


@pytest.fixture(autouse=True)
def _save_path_never_calls_the_model(monkeypatch):
    """保存路径上不许有模型调用——抽槽已挪到按需端点，退回去就是又让用户干等 20 秒。"""
    monkeypatch.setattr(
        "agentcore.workflows.slot_extract._ask_model",
        AsyncMock(side_effect=AssertionError("保存路径不得调用模型")),
    )


def _draft(plan: RunPlan, **kw):
    return draft_workflow_from_plan(
        plan, conversation_id=CONVERSATION_ID, message_id=MESSAGE_ID, **kw
    )


def test_reverse_mints_ids_and_rewrites_depends_on():
    """``del_<uuid>_write`` → ``write``，依赖引用同步反解，边不能断。"""
    draft = _draft(_research_write_plan())
    node_ids = [n["id"] for n in draft.definition["nodes"]]
    assert "research" in node_ids
    assert "write" in node_ids
    assert not any(nid.startswith("del_") for nid in node_ids)

    tasks = {t["id"]: t for t in expand_workflow_to_tasks(draft.definition)}
    assert tasks["write"]["depends_on"] == ["research"]
    assert tasks["write"]["checkpoint_after"] is True
    assert draft.node_count == 2


def test_definition_round_trips_back_into_a_run_plan():
    """固化出来的画布必须能原样复跑（expand → build_run_plan 不报错、边还在）。"""
    draft = _draft(_research_write_plan())
    plan, errors = build_run_plan(expand_workflow_to_tasks(draft.definition), id_prefix="wf")
    assert errors == []
    assert [n.run_id for n in plan.nodes] == ["wf_research", "wf_write"]
    assert plan.by_id("wf_write").depends_on == ["wf_research"]


def test_unmintable_run_ids_survive_and_collisions_get_a_suffix():
    """没有铸造前缀的 id 原样用；两个批次反解撞名时加序号而不是互相覆盖。"""
    plan = RunPlan(
        nodes=[
            _spec("wf_review", "审校", "审第一稿"),
            _spec(f"{_DEL}_review", "复审", "审第二稿"),
        ]
    )
    ids = [n["id"] for n in _draft(plan).definition["nodes"]]
    assert ids == ["wf_review", "review"]

    collide = RunPlan(
        nodes=[
            _spec(f"{_DEL}_review", "审校", "审第一稿"),
            _spec(f"{_ADD}_review", "复审", "审第二稿"),
        ]
    )
    assert [n["id"] for n in _draft(collide).definition["nodes"]] == ["review", "review_2"]


def test_folds_takeover_chain_and_keeps_its_steer():
    """用户「立即改此人」铸出的 ``_redir`` 接手节点折进原节点，操舵并入任务描述。"""
    original = f"{_DEL}_write"
    plan = RunPlan(
        nodes=[
            _spec(f"{_DEL}_research", "研究员", "调研现状"),
            _spec(original, "写手", "写报告", depends_on=[f"{_DEL}_research"]),
            _spec(
                f"{original}_redir",
                "写手",
                "写报告",
                depends_on=[f"{_DEL}_research"],
                replaces_run_id=original,
                steer="改成给董事会看的口径",
            ),
            _spec(
                f"{_ADD}_review",
                "审校",
                "审稿",
                # RunPlan.add 已把下游改指到接手节点上；折叠必须把它还原回原节点。
                depends_on=[f"{original}_redir"],
            ),
        ]
    )
    draft = _draft(plan)

    tasks = {t["id"]: t for t in expand_workflow_to_tasks(draft.definition)}
    assert set(tasks) == {"research", "write", "review"}
    assert tasks["review"]["depends_on"] == ["write"]
    assert "改成给董事会看的口径" in tasks["write"]["task"]
    assert "已折叠 1 个续跑 / 接手节点" in draft.description
    assert "中途操舵已并入任务描述" in draft.description


def test_folds_continuation_chain_to_its_root():
    """同人续派（``continue_from_run_id``）同样折回链首，不在画布上多出一步。"""
    root = f"{_DEL}_build"
    plan = RunPlan(
        nodes=[
            _spec(f"{_DEL}_spec", "架构", "定接口"),
            _spec(root, "工程", "实现", depends_on=[f"{_DEL}_spec"]),
            _spec(
                f"{_ADD}_build2",
                "工程",
                "接着实现",
                continue_from_run_id=root,
                steer="补上错误处理",
            ),
        ]
    )
    draft = _draft(plan)
    tasks = {t["id"]: t for t in expand_workflow_to_tasks(draft.definition)}
    assert set(tasks) == {"spec", "build"}
    assert "补上错误处理" in tasks["build"]["task"]


def test_accumulated_steer_block_is_normalised_into_the_task():
    """``apply_steer`` 攒出来的 ``- note`` 块并入时去重去前缀，保序。"""
    plan = _research_write_plan()
    plan.nodes[1].steer = "- 先给结论\n- 控制在两页内\n- 先给结论"
    tasks = {
        t["id"]: t for t in expand_workflow_to_tasks(_draft(plan).definition)
    }
    body = tasks["write"]["task"]
    assert body.startswith("根据调研写报告")
    assert body.count("先给结论") == 1
    assert body.index("先给结论") < body.index("控制在两页内")


def test_nested_subteam_snapshot_is_not_mistaken_for_the_canvas():
    """再派单的 worker 会把子团队计划写进同一条 journal——最后一条快照不能直接用。"""
    nested = RunPlan(
        nodes=[
            _spec(
                "sub_a", "子队员A", "子任务A", depth=2, parent_run_id=f"{_DEL}_research"
            ),
            _spec(
                "sub_b", "子队员B", "子任务B", depth=2, parent_run_id=f"{_DEL}_research"
            ),
        ]
    )
    draft = draft_workflow_from_journal(
        _journal(_research_write_plan(), nested),
        conversation_id=CONVERSATION_ID,
        message_id=MESSAGE_ID,
    )
    assert [n["id"] for n in draft.definition["nodes"] if n["kind"] == "agent_step"] == [
        "research",
        "write",
    ]
    assert "1 个嵌套子团队不进画布" in draft.description


def test_later_top_level_snapshot_wins_over_earlier_one():
    """中途 adjust / 波边界追加会重记快照，取最后一条顶层的那张图。"""
    grown = _research_write_plan()
    grown.nodes.append(_spec(f"{_ADD}_review", "审校", "审稿"))
    draft = draft_workflow_from_journal(
        _journal(_research_write_plan(), grown),
        conversation_id=CONVERSATION_ID,
        message_id=MESSAGE_ID,
    )
    assert draft.node_count == 3


def test_source_rides_beside_the_definition_not_inside_it():
    """来源是服务端权威元数据，落在自己的列上——画布里一个字都不留。"""
    draft = _draft(_research_write_plan())
    assert draft.source == {
        "kind": "turn",
        "conversation_id": CONVERSATION_ID,
        "message_id": MESSAGE_ID,
    }
    assert "source" not in draft.definition
    assert is_turn_sourced(draft.source)


def test_rejects_turn_without_plan_snapshot():
    """裸聊 / 单 Agent 回合：journal 里没有计划快照 → 422 家族错误。"""
    with pytest.raises(TurnWorkflowError, match="没有多队员协作"):
        draft_workflow_from_journal(
            [{"kind": "turn_end", "payload": {"finish_reason": "end_turn"}, "ts": None}],
            conversation_id=CONVERSATION_ID,
            message_id=MESSAGE_ID,
        )
    with pytest.raises(TurnWorkflowError, match="没有多队员协作"):
        draft_workflow_from_journal(
            None, conversation_id=CONVERSATION_ID, message_id=MESSAGE_ID
        )


def test_rejects_when_fewer_than_two_canvas_nodes():
    """独苗一个 worker，或折叠后只剩一个，都没有拆法可固化。"""
    solo = RunPlan(nodes=[_spec(f"{_DEL}_only", "独苗", "一个人干完")])
    with pytest.raises(TurnWorkflowError, match="不足以固化"):
        _draft(solo)

    root = f"{_DEL}_only"
    folded_to_one = RunPlan(
        nodes=[
            _spec(root, "独苗", "一个人干完"),
            _spec(f"{root}_redir", "独苗", "重来一次", replaces_run_id=root),
        ]
    )
    with pytest.raises(TurnWorkflowError, match="不足以固化"):
        _draft(folded_to_one)


def test_nested_only_turn_has_no_top_level_canvas():
    nested_only = RunPlan(
        nodes=[
            _spec("sub_a", "子队员A", "子任务A", depth=2, parent_run_id="w1"),
            _spec("sub_b", "子队员B", "子任务B", depth=2, parent_run_id="w1"),
        ]
    )
    with pytest.raises(TurnWorkflowError, match="没有多队员协作"):
        draft_workflow_from_journal(
            _journal(nested_only),
            conversation_id=CONVERSATION_ID,
            message_id=MESSAGE_ID,
        )


def test_degrade_notes_are_honest_instead_of_blocking_the_save():
    """model / thinking 带不进画布——说清楚，但不拦保存。"""
    plan = RunPlan(
        nodes=[
            _spec(
                f"{_DEL}_research",
                "研究员",
                "调研现状",
                model="deepseek-reasoner",
                thinking=True,
            ),
            _spec(f"{_DEL}_write", "写手", "写报告", model="kimi-k2", thinking=True),
        ]
    )
    draft = _draft(plan)
    assert draft.node_count == 2
    assert "deepseek-reasoner" in draft.description
    assert "kimi-k2" in draft.description
    assert "复跑按账户默认模型" in draft.description
    assert "思考档" in draft.description
    assert "执行细项不带入快照" in draft.description


def test_mixed_turn_says_out_loud_that_the_debate_is_not_in_the_snapshot():
    """先派单调研、后拉一场辩论：存下来的只有调研那半，降级说明必须写明这件事。

    这是本模块最要命的静默变质——辩论不写 ``plan_snapshot``，折叠对它一无所知，不另判就会
    把「半场协作」当整场交付给用户。
    """
    entries = [*_journal(_research_write_plan()), _debate_entry()]
    draft = draft_workflow_from_journal(
        entries, conversation_id=CONVERSATION_ID, message_id=MESSAGE_ID
    )
    assert [n["id"] for n in draft.definition["nodes"] if n["kind"] == "agent_step"] == [
        "research",
        "write",
    ]
    assert "辩论环节不在快照内" in draft.description


@pytest.mark.parametrize(
    "kind",
    ["debate_round_started", "debate_round", "debate_result", "debate_pretrial_started"],
)
def test_any_debate_fact_counts_as_a_debated_turn(kind: str):
    """开庭 / 单轮 / 收口 / 庭前取证——任一痕迹在，本轮就跑过辩论。"""
    assert turn_ran_debate([_debate_entry(kind)]) is True


def test_pure_delegate_turn_carries_no_debate_note():
    entries = _journal(_research_write_plan())
    assert turn_ran_debate(entries) is False
    draft = draft_workflow_from_journal(
        entries, conversation_id=CONVERSATION_ID, message_id=MESSAGE_ID
    )
    assert "辩论" not in draft.description


def test_debate_only_turn_is_rejected_by_name():
    """整轮只有辩论：折不出画布，但错误得说清是辩论——辩论显然也是多队员协作。"""
    with pytest.raises(TurnWorkflowError, match="辩论"):
        draft_workflow_from_journal(
            [_debate_entry("debate_pretrial_started"), _debate_entry("debate_result")],
            conversation_id=CONVERSATION_ID,
            message_id=MESSAGE_ID,
        )


def test_deliverable_is_carried_through_verbatim():
    """交付契约整份带走——裁掉引用模式 / 质量闸就等于复跑时偷换了验收标准。"""
    plan = _research_write_plan()
    deliverable = Deliverable(
        output_format="json",
        required_sections=["结论", "风险"],
        form="files",
        artifacts=["report/final.md"],
        artifact_dir="report",
        web_quality_scan=True,
        visual_critic=True,
        citation_mode="two_phase",
        code_audit_gate=True,
    )
    plan.nodes[1].deliverable = deliverable
    definition = _draft(plan).definition

    tasks = {t["id"]: t for t in expand_workflow_to_tasks(definition)}
    assert tasks["write"]["deliverable"] == asdict(deliverable)
    assert "deliverable" not in tasks["research"]

    # 复跑走同一条路：definition → tasks → RunPlan，运行时闸位逐字还原。
    replan, errors = build_run_plan(expand_workflow_to_tasks(definition), id_prefix="wf")
    assert errors == []
    assert replan.by_id("wf_write").deliverable == deliverable


class _FakeWorkflowRepo:
    """幂等短路查的是 ``source`` 列（真库上走 ``ix_user_workflows_turn_source``）。"""

    def __init__(self) -> None:
        self.rows: list[SimpleNamespace] = []
        self.creates = 0

    async def list_by_user(self, user_id: str):
        raise AssertionError("幂等判定不得再拉用户全部工作流内存扫——走 source 列的索引")

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

    async def create(self, *, user_id, name, definition, description=None, source=None):
        self.creates += 1
        now = datetime(2026, 8, 13, tzinfo=UTC)
        row = SimpleNamespace(
            id=f"wf-{self.creates}",
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


def _route_deps(entries: list[dict], workflow_repo: _FakeWorkflowRepo):
    return {
        "conv_repo": SimpleNamespace(
            get_by_id=AsyncMock(return_value=SimpleNamespace(id=CONVERSATION_ID))
        ),
        "msg_repo": SimpleNamespace(
            get_by_id=AsyncMock(
                return_value=SimpleNamespace(id=MESSAGE_ID, role="assistant")
            )
        ),
        "journal_repo": SimpleNamespace(load_owned=AsyncMock(return_value=entries)),
        "workflow_repo": workflow_repo,
    }


async def test_route_saves_once_and_returns_the_same_row_on_a_second_click():
    """幂等只认来源：同一轮再点一次不刷重复记录，``name`` 也不开隐藏分支。"""
    repo = _FakeWorkflowRepo()
    deps = _route_deps(_journal(_research_write_plan()), repo)
    user = SimpleNamespace(user_id="u1")

    first = await save_turn_as_workflow(
        CONVERSATION_ID, MESSAGE_ID, user, body=None, **deps
    )
    assert first.source is not None
    assert first.source.kind == "turn"
    assert first.source.conversation_id == CONVERSATION_ID
    assert first.source.message_id == MESSAGE_ID
    assert "source" not in first.definition
    assert first.name == "研究员 · 写手"

    second = await save_turn_as_workflow(
        CONVERSATION_ID,
        MESSAGE_ID,
        user,
        body=SaveTurnAsWorkflowRequest(name="换个名字"),
        **deps,
    )
    assert second.id == first.id
    assert second.name == first.name
    assert repo.creates == 1


async def test_route_422s_a_turn_without_multi_agent_collaboration():
    """裸聊回合按下按钮 → 422（可解释的校验失败），不是 500 也不是空工作流。"""
    repo = _FakeWorkflowRepo()
    deps = _route_deps([{"kind": "turn_end", "payload": {}, "ts": None}], repo)

    with pytest.raises(ValidationError) as exc:
        await save_turn_as_workflow(
            CONVERSATION_ID,
            MESSAGE_ID,
            SimpleNamespace(user_id="u1"),
            body=None,
            **deps,
        )
    assert exc.value.status_code == 422
    assert repo.creates == 0


async def test_route_404s_a_message_that_is_not_an_assistant_turn():
    """用户消息 / 别人的对话没有「这一轮」可固化。"""
    repo = _FakeWorkflowRepo()
    deps = _route_deps(_journal(_research_write_plan()), repo)
    deps["msg_repo"] = SimpleNamespace(
        get_by_id=AsyncMock(return_value=SimpleNamespace(id=MESSAGE_ID, role="user"))
    )

    with pytest.raises(NotFoundError):
        await save_turn_as_workflow(
            CONVERSATION_ID,
            MESSAGE_ID,
            SimpleNamespace(user_id="u1"),
            body=None,
            **deps,
        )
    assert repo.creates == 0


def test_generated_name_reads_like_the_team_and_explicit_name_wins():
    assert _draft(_research_write_plan()).name == "研究员 · 写手"

    big = RunPlan(
        nodes=[
            _spec(f"{_DEL}_a", "研究员", "调研"),
            _spec(f"{_DEL}_b", "写手", "写作"),
            _spec(f"{_DEL}_c", "审校", "审稿"),
        ]
    )
    assert _draft(big).name == "研究员等 3 人协作"
    assert _draft(big, name="  我的报告流  ").name == "我的报告流"
