"""阶段推进卡：fold 投影 / 点卡 410。遗留 pending 不进 recovery、不盖章。"""

from __future__ import annotations

import pytest

from agentcore.runtime.journal.pending_interactions import (
    fold_interactions,
    fold_pending_interactions,
    project_interaction_leaf,
)


def _valid_card(**overrides):
    base = {
        "motion": "一审判决是否过重",
        "sides": [
            {"key": "pro", "name": "正方", "stance": "支持一审判决正确"},
            {"key": "con", "name": "反方", "stance": "认为判赔过重"},
        ],
        "fact_pointers": ["#r1"],
        "rationale": "各方已握同一事实却价值对立，继续调研消解不了，需要对抗检验",
        "form": "debate",
    }
    base.update(overrides)
    return base


def test_fold_projects_stage_card_but_recovery_pending_excludes_it():
    entries = [
        {
            "type": "stage_card_required",
            "payload": {
                "stage_card_id": "sc_1",
                "conversation_id": "c",
                "motion": "命题",
                "sides": [
                    {"key": "a", "name": "甲", "stance": "倾向甲"},
                    {"key": "b", "name": "乙", "stance": "倾向乙"},
                ],
                "form": "debate",
                "rationale": "真对立轴需对抗检验",
                "fact_pointers": [],
                "max_rounds": 5,
            },
        }
    ]
    pending = fold_pending_interactions(entries, message_id="m1")
    assert pending == []
    recs = fold_interactions(entries)
    assert len(recs) == 1
    assert recs[0].kind == "stage_card"
    assert recs[0].id == "sc_1"
    leaf = project_interaction_leaf(recs[0])
    assert leaf["kind"] == "stage_card"
    assert leaf["motion"] == "命题"


@pytest.mark.asyncio
async def test_refuse_stage_card_resolve_is_gone():
    from agentcore.core.errors import GoneError
    from agentcore.runtime.kickoff.retired import (
        STAGE_CARD_UNRECOVERABLE,
        refuse_stage_card_resolve,
    )

    with pytest.raises(GoneError, match="开辩请直接") as ei:
        refuse_stage_card_resolve()
    assert ei.value.message == STAGE_CARD_UNRECOVERABLE


@pytest.mark.asyncio
async def test_drive_top_level_no_longer_hangs_team_preview(monkeypatch):
    """顶层也不再挂 team_preview。"""
    from agentcore.core.types import AutonomyPolicy
    from agentcore.runtime.delegate.drive import _team_preview_before_workers
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunSpec

    monkeypatch.setattr(
        "agentcore.runtime.sandbox_approval.worker_gate_applies", lambda *_a, **_k: False
    )

    class _Tool:
        _depth = 0
        _permission_axes = AutonomyPolicy.LESS_INTERRUPT
        _active_playbook = None
        _pending_pause = False
        _base_tool_context = type("C", (), {"backend": None})()
        _approval_gate = None

    plan = RunPlan(nodes=[RunSpec(run_id="a", agent_id="a", role="r", task="t")])
    result = await _team_preview_before_workers(
        _Tool(),
        plan,
        complexity_hint="standard",
        seed_completed=None,
        call_idx=0,
    )
    assert result is None
    result2 = await _team_preview_before_workers(
        _Tool(),
        plan,
        complexity_hint="standard",
        seed_completed=None,
        call_idx=1,
    )
    assert result2 is None


@pytest.mark.asyncio
async def test_list_recent_turn_ids_orders_by_session_not_in_turn_seq():
    """长回合高 seq 不得挤掉更早回合的扫描窗口。"""
    from agentcore.db.repositories.runs import TurnJournalRepository

    class _Result:
        def __init__(self, rows):
            self._rows = rows

        def scalars(self):
            return self

        def all(self):
            return self._rows

    class _Session:
        def __init__(self):
            self.last_stmt = None

        async def execute(self, stmt):
            self.last_stmt = stmt
            return _Result(["turn_new", "turn_old_with_card"])

    session = _Session()
    repo = TurnJournalRepository(session)
    ids = await repo.list_recent_turn_ids("conv", limit=40)
    assert ids == ["turn_new", "turn_old_with_card"]
    sql = str(session.last_stmt)
    assert "max" in sql.lower() or "GROUP BY" in sql.upper()


@pytest.mark.asyncio
async def test_oral_debate_does_not_consume_stage_card(monkeypatch):
    """口头开辩是独立重活：不消费推进卡、不走 stage_card 授权。"""
    import tempfile
    from pathlib import Path

    from agentcore.runtime.events import EventSink
    from agentcore.tools.builtin.debate.tool import DebateTool
    from agentcore.tools.protocol import ToolContext, ToolEffect, ToolResult
    from agentcore.tools.registry import ToolRegistry
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.server import ServerWorkspace
    from tests.delegate.conftest import Provider

    async def _fake_run(self, config, usage_metadata):
        return ToolResult(
            tool_call_id="",
            success=True,
            output="ok",
            effect=ToolEffect.CONTINUE,
        )

    monkeypatch.setattr(DebateTool, "_run_moderator", _fake_run)

    backend = ServerWorkspace(
        root=Path(tempfile.mkdtemp(prefix="stage_card_ws_")),
        sandbox=SubprocessSandbox(),
    )
    ctx = ToolContext.create(
        execution_id="e",
        run_id="captain",
        agent_id="CEO",
        backend=backend,
        user_id="u",
        conversation_id="conv_sc",
    )
    tool = DebateTool(
        llm=Provider([]),
        sink=EventSink(),
        system_prompt="sys",
        user_message="开辩",
        tools=ToolRegistry(),
        base_tool_context=ctx,
        conversation_id="conv_sc",
        message_id="m_debate",
        captain_run_id="captain",
        approval_gate=None,
    )
    result = await tool.execute(
        {
            "motion": _valid_card()["motion"],
            "form": "debate",
            "sides": _valid_card()["sides"],
        },
        tool._base_tool_context,
    )
    assert result.success is True
    assert tool._debate_authorized_by in (None, "auto")
