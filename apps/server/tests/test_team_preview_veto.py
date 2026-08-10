"""开工组队有限否决 — validate / apply / recover 行为单测。"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from agentcore.core.errors import ValidationError
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.kickoff.team_veto import (
    apply_team_preview_veto,
    normalize_write_capability_overrides,
    should_apply_team_veto,
    validate_team_preview_veto,
    validate_team_preview_veto_workers,
)
from agentcore.runtime.recover import recover_turn
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import Deliverable, RunSpec
from agentcore.runtime.suspension import TeamPreviewSuspension
from agentcore.runtime.turn_state import TurnState
from agentcore.tools.protocol import ToolEffect, ToolResult


def _plan_two_independent() -> RunPlan:
    plan = RunPlan()
    plan.add(
        RunSpec(
            run_id="a",
            task="调研",
            role="研究员",
            deliverable=Deliverable(form="files", artifacts=["notes.md"]),
        )
    )
    plan.add(
        RunSpec(
            run_id="b",
            task="撰写",
            role="写手",
            deliverable=Deliverable(form="files", artifacts=["out.md"]),
        )
    )
    return plan


def _plan_with_dep() -> RunPlan:
    plan = RunPlan()
    plan.add(RunSpec(run_id="a", task="调研", role="研究员"))
    plan.add(RunSpec(run_id="b", task="撰写", role="写手", depends_on=["a"]))
    return plan


def _frame(
    plan: RunPlan,
    *,
    primitive: str = "delegate",
    debate_arguments: dict | None = None,
) -> TeamPreviewSuspension:
    return TeamPreviewSuspension(
        message_id="m1",
        conversation_id="c1",
        user_id="u1",
        captain_run_id="cap1",
        checkpoint_id="ck1",
        tool_call_id="tc1",
        base_system_prompt="sys",
        user_message="task",
        plan=plan,
        primitive=primitive,
        debate_arguments=dict(debate_arguments or {}),
        coordination="wall" if primitive == "delegate" else "none",
    )


def _state(plan: RunPlan) -> TurnState:
    return TurnState(
        plan=plan, completed={}, execution_id="e1", coordination=None, entries=()
    )


def test_exclude_one_worker_keeps_other():
    plan = _plan_two_independent()
    validate_team_preview_veto(plan, excluded_run_ids=["b"])
    excl, _, _ = apply_team_preview_veto(plan, excluded_run_ids=["b"])
    assert excl == ["b"]
    assert [n.run_id for n in plan.nodes] == ["a"]


def test_tighten_write_sets_form_prose():
    plan = _plan_two_independent()
    validate_team_preview_veto(
        plan,
        write_capability_overrides=[{"run_id": "a", "capability": "text_only"}],
    )
    _, overrides, _ = apply_team_preview_veto(
        plan,
        write_capability_overrides=[{"run_id": "a", "capability": "text_only"}],
    )
    assert overrides[0].run_id == "a"
    node = plan.by_id("a")
    assert node is not None and node.deliverable is not None
    assert node.deliverable.form == "prose"
    # 禁硬卸写工具：deliverable 仍在，仅 form 收紧。
    assert node.deliverable.artifacts == ["notes.md"]


def test_model_override_writes_route_key():
    plan = _plan_two_independent()
    validate_team_preview_veto(
        plan,
        model_overrides={
            "a": {"model": "deepseek-v4-pro", "origin": "platform"},
        },
    )
    _, _, models = apply_team_preview_veto(
        plan,
        model_overrides={
            "a": {"model": "deepseek-v4-pro", "origin": "platform"},
        },
    )
    assert models[0].run_id == "a"
    assert plan.by_id("a").model == "platform/deepseek-v4-pro"
    assert plan.by_id("b").model == ""


def test_model_override_bare_model_rejected():
    plan = _plan_two_independent()
    with pytest.raises(ValidationError, match="origin"):
        validate_team_preview_veto(
            plan,
            model_overrides={"a": {"model": "deepseek-v4-pro"}},
        )


def test_model_override_unknown_run_rejected():
    plan = _plan_two_independent()
    with pytest.raises(ValidationError, match="未知"):
        validate_team_preview_veto(
            plan,
            model_overrides={"nope": {"model": "x", "origin": "platform"}},
        )


def test_model_override_empty_skips():
    plan = _plan_two_independent()
    validate_team_preview_veto(plan, model_overrides={"a": {"model": ""}})
    _, _, models = apply_team_preview_veto(plan, model_overrides={"a": {"model": ""}})
    assert models == []
    assert plan.by_id("a").model == ""


def test_exclude_dependency_target_rejected():
    plan = _plan_with_dep()
    with pytest.raises(ValidationError, match="依赖"):
        validate_team_preview_veto(plan, excluded_run_ids=["a"])


def test_illegal_upgrade_capability_rejected():
    with pytest.raises(ValidationError, match="升权|text_only"):
        normalize_write_capability_overrides(
            [{"run_id": "a", "capability": "can_write_files"}]
        )
    plan = _plan_two_independent()
    with pytest.raises(ValidationError, match="升权|text_only"):
        validate_team_preview_veto(
            plan,
            write_capability_overrides=[{"run_id": "a", "capability": "can_write_files"}],
        )


def test_unknown_id_and_empty_team_rejected():
    plan = _plan_two_independent()
    with pytest.raises(ValidationError, match="未知"):
        validate_team_preview_veto(plan, excluded_run_ids=["nope"])
    with pytest.raises(ValidationError, match="至少保留"):
        validate_team_preview_veto(plan, excluded_run_ids=["a", "b"])


def test_debate_should_not_apply_veto():
    frame = _frame(RunPlan(), primitive="debate")
    assert should_apply_team_veto(frame, CheckpointDecision.CONTINUE) is False
    assert should_apply_team_veto(frame, "continue") is False


def test_debate_should_apply_model_overrides():
    from agentcore.runtime.kickoff.team_veto import should_apply_debate_model_overrides

    frame = _frame(RunPlan(), primitive="debate")
    assert should_apply_debate_model_overrides(frame, CheckpointDecision.CONTINUE) is True
    assert should_apply_debate_model_overrides(frame, CheckpointDecision.STOP) is False
    assert should_apply_debate_model_overrides(_frame(RunPlan()), CheckpointDecision.CONTINUE) is False


def test_allocate_debate_run_ids_idempotent():
    from agentcore.runtime.debate import DebateConfig, DebateForm, DebateSide, RoundPolicy
    from agentcore.runtime.debate.models import allocate_debate_run_ids

    config = DebateConfig(
        motion="命题",
        form=DebateForm.DEBATE,
        sides=[
            DebateSide(key="pro", name="正方", stance="赞"),
            DebateSide(key="con", name="反方", stance="反"),
        ],
        policy=RoundPolicy(thorough=True, max_rounds=3),
    )
    args = {
        "motion": "命题",
        "form": "debate",
        "sides": [
            {"key": "pro", "name": "正方", "stance": "赞"},
            {"key": "con", "name": "反方", "stance": "反"},
        ],
    }
    mod = allocate_debate_run_ids(config, args)
    assert mod.startswith("debate_")
    assert config.moderator_run_id == mod
    assert config.sides[0].run_id == f"{mod}_pro"
    assert config.sides[1].run_id == f"{mod}_con"
    assert args["moderator_run_id"] == mod
    assert args["sides"][0]["run_id"] == f"{mod}_pro"
    mod2 = allocate_debate_run_ids(config, args)
    assert mod2 == mod
    assert config.sides[0].run_id == f"{mod}_pro"


def test_apply_debate_model_overrides_writes_arguments():
    from agentcore.runtime.kickoff.team_veto import (
        apply_debate_model_overrides,
        validate_debate_model_overrides,
    )

    mod = "debate_abc"
    pro = f"{mod}_pro"
    args = {
        "moderator_run_id": mod,
        "moderator_model": "deepseek-v4-flash",
        "moderator_origin": "platform",
        "sides": [
            {"key": "pro", "name": "正方", "stance": "赞", "run_id": pro, "model": "a", "origin": "platform"},
            {
                "key": "con",
                "name": "反方",
                "stance": "反",
                "run_id": f"{mod}_con",
                "model": "b",
                "origin": "platform",
            },
        ],
    }
    sides = [dict(s) for s in args["sides"]]
    ov = {
        pro: {"model": "deepseek-v4-pro", "origin": "platform"},
        mod: {"model": "gpt-test", "origin": "platform"},
    }
    validate_debate_model_overrides(sides, debate_arguments=args, model_overrides=ov)
    applied = apply_debate_model_overrides(args, ov, sides=sides)
    assert applied[pro]["model"] == "deepseek-v4-pro"
    assert applied[mod]["model"] == "gpt-test"
    assert args["sides"][0]["model"] == "deepseek-v4-pro"
    assert args["moderator_model"] == "gpt-test"
    assert sides[0]["model"] == "deepseek-v4-pro"


def test_debate_model_override_unknown_run_rejected():
    from agentcore.runtime.kickoff.team_veto import validate_debate_model_overrides

    with pytest.raises(ValidationError, match="未知"):
        validate_debate_model_overrides(
            [{"key": "pro", "run_id": "debate_x_pro"}],
            moderator_run_id="debate_x",
            model_overrides={"nope": {"model": "m", "origin": "platform"}},
        )


@pytest.mark.asyncio
async def test_recover_debate_applies_model_overrides():
    mod = "debate_abc"
    pro = f"{mod}_pro"
    args = {
        "motion": "是否",
        "form": "debate",
        "moderator_run_id": mod,
        "sides": [
            {"key": "pro", "name": "正方", "stance": "赞", "run_id": pro},
            {"key": "con", "name": "反方", "stance": "反", "run_id": f"{mod}_con"},
        ],
    }
    frame = _frame(
        RunPlan(),
        primitive="debate",
        debate_arguments=args,
    )
    frame.sides = [dict(s) for s in args["sides"]]
    sink = EventSink()
    seen_args = {}

    async def _resume_debate(**kwargs):
        seen_args.update(kwargs.get("arguments") or {})
        return ToolResult(
            tool_call_id="", success=True, output="开辩", effect=ToolEffect.CONTINUE
        )

    debate = AsyncMock()
    debate.resume_after_kickoff = _resume_debate
    delegate = AsyncMock()
    settled = await recover_turn(
        state=_state(RunPlan()),
        sink=sink,
        delegate_tool=delegate,
        debate_tool=debate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
        note="",
        model_overrides={
            pro: {"model": "deepseek-v4-pro", "origin": "platform"},
        },
        excluded_run_ids=["b"],
    )
    assert settled.output == "开辩"
    assert seen_args["sides"][0]["model"] == "deepseek-v4-pro"
    resolved = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_RESOLVED]
    assert resolved[0].payload.get("model_overrides") == {
        pro: {"model": "deepseek-v4-pro", "origin": "platform"},
    }
    assert "excluded_run_ids" not in resolved[0].payload


def test_prose_override_idempotent():
    plan = RunPlan()
    plan.add(
        RunSpec(
            run_id="a",
            task="答",
            role="分析",
            deliverable=Deliverable(form="prose"),
        )
    )
    plan.add(RunSpec(run_id="b", task="写", role="写手"))
    validate_team_preview_veto(
        plan,
        write_capability_overrides=[{"run_id": "a", "capability": "text_only"}],
    )
    apply_team_preview_veto(
        plan,
        write_capability_overrides=[{"run_id": "a", "capability": "text_only"}],
    )
    assert plan.by_id("a").deliverable.form == "prose"


@pytest.mark.asyncio
async def test_recover_exclude_one_before_resume_plan():
    plan = _plan_two_independent()
    frame = _frame(plan)
    sink = EventSink()
    called: dict = {}

    async def _resume(p, seed, **kwargs):
        called["nodes"] = [n.run_id for n in p.nodes]
        called["kwargs"] = kwargs
        return ToolResult(
            tool_call_id="", success=True, output="团队已启动", effect=ToolEffect.CONTINUE
        )

    delegate = AsyncMock()
    delegate.resume_plan = _resume
    settled = await recover_turn(
        state=_state(plan),
        sink=sink,
        delegate_tool=delegate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
        note="",
        excluded_run_ids=["b"],
    )
    assert settled.output == "团队已启动"
    assert called["nodes"] == ["a"]
    resolved = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_RESOLVED]
    assert len(resolved) == 1
    assert resolved[0].payload.get("excluded_run_ids") == ["b"]


@pytest.mark.asyncio
async def test_recover_debate_ignores_excluded_fields():
    plan = _plan_two_independent()
    frame = _frame(
        plan, primitive="debate", debate_arguments={"motion": "是否", "form": "debate"}
    )
    sink = EventSink()

    async def _resume_debate(**kwargs):
        return ToolResult(
            tool_call_id="", success=True, output="开辩", effect=ToolEffect.CONTINUE
        )

    debate = AsyncMock()
    debate.resume_after_kickoff = _resume_debate
    delegate = AsyncMock()
    settled = await recover_turn(
        state=_state(plan),
        sink=sink,
        delegate_tool=delegate,
        debate_tool=debate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
        note="",
        excluded_run_ids=["b"],
        write_capability_overrides=[{"run_id": "a", "capability": "text_only"}],
    )
    assert settled.output == "开辩"
    delegate.resume_plan.assert_not_called()
    resolved = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_RESOLVED]
    assert "excluded_run_ids" not in resolved[0].payload
    assert [n.run_id for n in plan.nodes] == ["a", "b"]


@pytest.mark.asyncio
async def test_recover_model_override_registers_route_extras(monkeypatch):
    """人盖模后须补 ensure_delegate_route_extras（跨 provider 云端 in-process）。"""
    plan = _plan_two_independent()
    frame = _frame(plan)
    sink = EventSink()
    seen: list[object] = []

    async def _extras(llm, identities, *, user_id=None):
        seen.append(list(identities))

    monkeypatch.setattr(
        "agentcore.runtime.delegate.task_models.ensure_delegate_route_extras",
        _extras,
    )

    async def _resume(p, seed, **kwargs):
        assert p.by_id("a").model == "platform/deepseek-v4-pro"
        return ToolResult(
            tool_call_id="", success=True, output="ok", effect=ToolEffect.CONTINUE
        )

    delegate = AsyncMock()
    delegate.resume_plan = _resume
    delegate._llm = object()
    delegate._base_tool_context = type("Ctx", (), {"user_id": "u1"})()

    await recover_turn(
        state=_state(plan),
        sink=sink,
        delegate_tool=delegate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
        model_overrides={
            "a": {"model": "deepseek-v4-pro", "origin": "platform"},
        },
    )
    assert len(seen) == 1
    assert seen[0][0].model == "deepseek-v4-pro"
    assert seen[0][0].origin == "platform"
    resolved = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_RESOLVED]
    assert resolved[0].payload.get("model_overrides") == {
        "a": {"model": "deepseek-v4-pro", "origin": "platform"},
    }


@pytest.mark.asyncio
async def test_recover_ceo_route_key_registers_extras_without_override(monkeypatch):
    """冷 resume：人未改模时，plan 上 CEO 已写路由键也须补 extras。"""
    plan = _plan_two_independent()
    plan.by_id("a").model = "prov-x/custom-model"
    frame = _frame(plan)
    sink = EventSink()
    seen: list[object] = []

    async def _extras(llm, identities, *, user_id=None):
        seen.append(list(identities))

    monkeypatch.setattr(
        "agentcore.runtime.delegate.task_models.ensure_delegate_route_extras",
        _extras,
    )

    async def _resume(p, seed, **kwargs):
        return ToolResult(
            tool_call_id="", success=True, output="ok", effect=ToolEffect.CONTINUE
        )

    delegate = AsyncMock()
    delegate.resume_plan = _resume
    delegate._llm = object()
    delegate._base_tool_context = type("Ctx", (), {"user_id": "u1"})()

    await recover_turn(
        state=_state(plan),
        sink=sink,
        delegate_tool=delegate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
    )
    assert len(seen) == 1
    assert seen[0][0].model == "custom-model"
    assert seen[0][0].origin == "byok"
    assert seen[0][0].provider_id == "prov-x"


@pytest.mark.asyncio
async def test_recover_tighten_write_then_resume():
    plan = _plan_two_independent()
    frame = _frame(plan)
    sink = EventSink()
    forms: dict[str, str | None] = {}

    async def _resume(p, seed, **kwargs):
        for n in p.nodes:
            forms[n.run_id] = n.deliverable.form if n.deliverable else None
        return ToolResult(
            tool_call_id="", success=True, output="ok", effect=ToolEffect.CONTINUE
        )

    delegate = AsyncMock()
    delegate.resume_plan = _resume
    await recover_turn(
        state=_state(plan),
        sink=sink,
        delegate_tool=delegate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
        write_capability_overrides=[{"run_id": "a", "capability": "text_only"}],
    )
    assert forms["a"] == "prose"
    assert forms["b"] == "files"
    resolved = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_RESOLVED]
    assert resolved[0].payload.get("write_capability_overrides") == [
        {"run_id": "a", "capability": "text_only"}
    ]


def test_workers_validate_dep_and_unknown():
    workers = [
        {"run_id": "a", "depends_on": []},
        {"run_id": "b", "depends_on": ["a"]},
    ]
    with pytest.raises(ValidationError, match="依赖"):
        validate_team_preview_veto_workers(workers, excluded_run_ids=["a"])
    with pytest.raises(ValidationError, match="未知"):
        validate_team_preview_veto_workers(workers, excluded_run_ids=["z"])
    validate_team_preview_veto_workers(workers, excluded_run_ids=["b"])


@pytest.mark.asyncio
async def test_recover_invalid_veto_emits_no_resolved():
    """非法否决：validate 先于 emit —— sink 不得先落 team_preview_resolved。"""
    plan = _plan_two_independent()
    frame = _frame(plan)
    sink = EventSink()
    delegate = AsyncMock()

    with pytest.raises(ValidationError, match="未知"):
        await recover_turn(
            state=_state(plan),
            sink=sink,
            delegate_tool=delegate,
            execution_id="e1",
            suspension=frame,
            decision=CheckpointDecision.CONTINUE,
            excluded_run_ids=["nope"],
        )

    resolved = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_RESOLVED]
    assert resolved == []
    delegate.resume_plan.assert_not_called()


@pytest.mark.asyncio
async def test_explore_gate_not_invoked_on_pruned_resume():
    """剪枝剩 1 人：resume_plan 路径不跑 cold_start_explore≥2 闸。"""
    plan = _plan_two_independent()
    frame = _frame(plan)
    sink = EventSink()

    async def _resume(p, seed, **kwargs):
        assert len(p.nodes) == 1
        return ToolResult(
            tool_call_id="", success=True, output="ok", effect=ToolEffect.CONTINUE
        )

    delegate = AsyncMock()
    delegate.resume_plan = _resume
    delegate.execute = AsyncMock(
        side_effect=AssertionError("resume must not call execute / explore gate")
    )
    await recover_turn(
        state=_state(plan),
        sink=sink,
        delegate_tool=delegate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.CONTINUE,
        excluded_run_ids=["b"],
    )
    delegate.execute.assert_not_called()
