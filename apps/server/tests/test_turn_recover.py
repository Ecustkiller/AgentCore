"""TurnState projection + recover_turn + lease sweeper (crash recover).

Pins the single recover primitive: journal → TurnState → seed WaveScheduler
(completed skipped) for crash redrive; resume kinds route through the same path.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink
from agentcore.runtime.recover import recover_turn
from agentcore.runtime.runs import RunPlan, RunSpec
from agentcore.runtime.runs.serialize import plan_snapshot_fact, plan_to_json, run_final_fact
from agentcore.runtime.runs.types import RunPhase, RunState
from agentcore.runtime.turn_state import TurnState
from agentcore.tools.protocol import ToolResult


def _plan_two_nodes() -> RunPlan:
    return RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="done", role="研究员"),
            RunSpec(run_id="w2", task="pending", role="写手"),
        ]
    )


def _partial_journal() -> list[dict]:
    """Plan + one completed worker + run_plan execution_id (no turn_end)."""
    plan = _plan_two_nodes()
    completed = RunState(phase=RunPhase.COMPLETED, content="ok")
    snap = plan_snapshot_fact(plan)
    final = run_final_fact("w1", completed)
    return [
        {
            "kind": "run_plan",
            "payload": {"execution_id": "exec-crash-1"},
            "ts": "t0",
            "seq": 0,
        },
        {**snap.entry(), "seq": 1},
        {**final.entry(), "seq": 2},
    ]


def test_turn_state_from_journal_projects_plan_completed_execution_id():
    entries = _partial_journal()
    state = TurnState.from_journal(entries)
    assert state.execution_id == "exec-crash-1"
    assert state.plan is not None
    assert [n.run_id for n in state.plan.nodes] == ["w1", "w2"]
    assert set(state.completed) == {"w1"}
    assert state.completed["w1"].phase is RunPhase.COMPLETED
    assert state.unfinished_run_ids == ["w2"]


def test_turn_state_upto_seq_time_travel():
    entries = _partial_journal()
    # Before the completed fact — no seed yet, both unfinished.
    early = TurnState.from_journal(entries, upto_seq=1)
    assert early.completed == {}
    assert early.plan is not None
    assert early.unfinished_run_ids == ["w1", "w2"]


async def test_recover_turn_crash_redrives_with_seed_completed():
    state = TurnState.from_journal(_partial_journal())
    sink = EventSink()
    seen: dict = {}

    async def _resume_plan(plan, seed_completed, **kwargs):
        seen["plan_ids"] = [n.run_id for n in plan.nodes]
        seen["seed"] = set(seed_completed)
        seen["decision"] = kwargs.get("decision")
        seen["execution_id"] = kwargs.get("execution_id")
        return ToolResult(tool_call_id="t1", success=True, output="redriven")

    delegate = MagicMock()
    delegate.resume_plan = _resume_plan

    settled = await recover_turn(
        state=state,
        sink=sink,
        delegate_tool=delegate,
        execution_id="fresh-should-not-win",
    )
    assert settled.output == "redriven"
    assert settled.terminal_text is None
    assert seen["seed"] == {"w1"}
    assert seen["plan_ids"] == ["w1", "w2"]
    assert seen["decision"] is CheckpointDecision.CONTINUE
    assert seen["execution_id"] == "exec-crash-1"


async def test_recover_turn_resume_plan_review_routes_through_same_primitive():
    from agentcore.runtime.suspension import PlanReviewSuspension

    state = TurnState.from_journal(_partial_journal())
    sink = EventSink()
    seen: dict = {}

    async def _resume_plan(plan, seed_completed, **kwargs):
        seen["seed"] = set(seed_completed)
        seen["decision"] = kwargs.get("decision")
        return ToolResult(tool_call_id="t1", success=True, output="resumed")

    delegate = MagicMock()
    delegate.resume_plan = _resume_plan

    suspension = PlanReviewSuspension(
        message_id="m1",
        conversation_id="c1",
        user_id="u1",
        captain_run_id="cap1",
        checkpoint_id="cp1",
        tool_call_id="tc1",
        user_message="task",
        base_system_prompt="sys",
        journal_entries=_partial_journal(),
        plan=state.plan or _plan_two_nodes(),
        completed=dict(state.completed),
        steps=[{"run_id": "w1", "role": "研究员", "summary": "…"}],
        pending=[{"run_id": "w2", "role": "写手"}],
    )

    settled = await recover_turn(
        state=state,
        sink=sink,
        delegate_tool=delegate,
        execution_id="x",
        suspension=suspension,
        decision=CheckpointDecision.CONTINUE,
        note="",
    )
    assert settled.output == "resumed"
    assert seen["seed"] == {"w1"}
    assert seen["decision"] is CheckpointDecision.CONTINUE


async def test_sweeper_claims_expired_lease_and_invokes_recover(monkeypatch):
    """Lease + partial journal + no live process → sweeper starts recover with unfinished DAG."""
    from datetime import UTC, datetime, timedelta

    from agentcore.runtime.leases import sweeper as sweeper_mod

    message_id = "11111111-1111-1111-1111-111111111111"
    conversation_id = "22222222-2222-2222-2222-222222222222"
    user_id = "33333333-3333-3333-3333-333333333333"
    entries = _partial_journal()
    expired_row = SimpleNamespace(
        message_id=message_id,
        conversation_id=conversation_id,
        user_id=user_id,
        owner_id="dead-owner",
        phase="running",
        meta={},
        heartbeat_at=datetime.now(UTC) - timedelta(hours=1),
    )
    claimed_row = SimpleNamespace(
        message_id=message_id,
        conversation_id=conversation_id,
        user_id=user_id,
        owner_id="new-owner",
        phase="recovering",
        meta={},
        heartbeat_at=datetime.now(UTC),
    )

    recover_calls: list = []

    async def _fake_recover(lease, state):
        recover_calls.append((lease.message_id, set(state.completed), state.unfinished_run_ids))

    class _FakeLeaseRepo:
        def __init__(self, _session):
            pass

        async def list_expired(self, *, before, limit):
            return [expired_row]

        async def claim_expired(self, mid, *, new_owner_id, before, phase="recovering"):
            assert mid == message_id
            return claimed_row

        async def release(self, mid, *, owner_id=None):
            pass

    class _FakePausedRepo:
        def __init__(self, _session):
            pass

        async def get(self, mid):
            return None

    class _FakeJournalRepo:
        def __init__(self, _session):
            pass

        async def load_owned(self, turn_id, conversation_id):
            return entries

    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr(sweeper_mod, "TurnLeaseRepository", _FakeLeaseRepo)
    monkeypatch.setattr(sweeper_mod, "PausedTurnRepository", _FakePausedRepo)
    monkeypatch.setattr(sweeper_mod, "TurnJournalRepository", _FakeJournalRepo)
    monkeypatch.setattr(sweeper_mod, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(sweeper_mod.settings, "turn_lease_enabled", True)
    monkeypatch.setattr(
        "agentcore.runtime.recover.recover_expired_lease",
        _fake_recover,
    )

    pending: list = []

    def _capture_task(coro, name=None):
        pending.append(coro)
        return MagicMock()

    monkeypatch.setattr(sweeper_mod.asyncio, "create_task", _capture_task)

    started = await sweeper_mod.run_turn_lease_sweep()
    assert started == 1
    assert len(pending) == 1
    await pending[0]
    assert len(recover_calls) == 1
    mid, completed, unfinished = recover_calls[0]
    assert mid == message_id
    assert completed == {"w1"}
    assert unfinished == ["w2"]


def test_plan_snapshot_round_trip_via_turn_state():
    plan = _plan_two_nodes()
    entries = [{**plan_snapshot_fact(plan).entry()}]
    state = TurnState.from_journal(entries)
    assert plan_to_json(state.plan) == plan_to_json(plan)
