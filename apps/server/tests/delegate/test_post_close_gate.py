"""收口后冷开整团重派硬闸（与同图 replan 补跑闸分轨）。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agentcore.runtime.delegate.force_scopes import (
    EMPTY_FORCE_SCOPES,
    GATE_POST_CLOSE,
    ForceScopes,
)
from agentcore.runtime.delegate.post_close_gate import (
    EXECUTION_HARVEST_ORIGIN,
    POST_CLOSE_REJECT_COLD_OPEN,
    POST_CLOSE_REJECT_GAP_FILL,
    post_close_cold_open_error,
    post_close_reject,
)
from agentcore.runtime.runs.constants import MAX_GAP_FILL_ADDS
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunSpec


def _tool(*, origin: str = "", force: bool = False, depth: int = 0) -> MagicMock:
    t = MagicMock()
    t._user_message_origin = origin
    t._force_scopes = (
        ForceScopes(frozenset({GATE_POST_CLOSE})) if force else EMPTY_FORCE_SCOPES
    )
    t._depth = depth
    t._conversation_id = "conv-post-close"
    t._base_tool_context = SimpleNamespace(execution_id="exec-post-close")
    return t


def _substantial_unnamed(*, n: int = 3) -> RunPlan:
    return RunPlan(
        nodes=[
            RunSpec(run_id=f"n{i}", role=f"R{i}", task=f"task {i}") for i in range(n)
        ]
    )


def _named_replaces(gap_ids: list[str]) -> RunPlan:
    return RunPlan(
        nodes=[
            RunSpec(
                run_id=f"retry_{gid}",
                role=f"R_{gid}",
                task=f"retry {gid}",
                replaces_run_id=gid,
            )
            for gid in gap_ids
        ]
    )


def test_post_close_rejects_unnamed_substantial_fanout():
    """三元组①：收口后无缺口/未点名大扇出 → 拒。"""
    reject = post_close_reject(
        _tool(origin=EXECUTION_HARVEST_ORIGIN),
        _substantial_unnamed(n=3),
    )
    assert reject is not None
    assert reject.kind == POST_CLOSE_REJECT_COLD_OPEN
    err = reject.message
    assert "收口后拒绝整团重派" in err
    # 拒绝正文指向真实可用的续派入口 + 本闸自己的 scope（不再是一键全开）。
    assert "continue_from_run_id" in err
    assert 'force=["post_close"]' in err
    assert "force=true" not in err


def test_post_close_allows_named_gap_fill_within_cap(monkeypatch):
    """三元组②：有缺口 + 点名补 ≤ MAX_GAP_FILL_ADDS → 放行。"""
    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        clear_active_coordination,
        set_active_coordination,
    )

    clear_active_coordination()
    session = CoordinationSession(execution_id="exec-post-close", total_workers=4)
    session.conversation_id = "conv-post-close"
    session.completed_run_ids = {"f1", "f2", "ok"}
    session.failed_run_ids = {"f1", "f2"}
    session.active = False
    set_active_coordination(session)
    try:
        gaps = ["f1", "f2"]
        assert len(gaps) <= MAX_GAP_FILL_ADDS
        err = post_close_cold_open_error(
            _tool(origin=EXECUTION_HARVEST_ORIGIN),
            _named_replaces(gaps),
        )
        assert err is None
    finally:
        clear_active_coordination("exec-post-close")


def test_post_close_rejects_named_over_cap(monkeypatch):
    """三元组③：点名补超过 min(|gaps|, MAX_GAP_FILL_ADDS) → 拒。"""
    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        clear_active_coordination,
        set_active_coordination,
    )

    clear_active_coordination()
    n_gaps = MAX_GAP_FILL_ADDS + 1
    gap_ids = [f"f{i}" for i in range(1, n_gaps + 1)]
    session = CoordinationSession(execution_id="exec-post-close", total_workers=n_gaps)
    session.conversation_id = "conv-post-close"
    session.completed_run_ids = set(gap_ids)
    session.failed_run_ids = set(gap_ids)
    session.active = False
    set_active_coordination(session)
    try:
        reject = post_close_reject(
            _tool(origin=EXECUTION_HARVEST_ORIGIN),
            _named_replaces(gap_ids),
        )
        assert reject is not None
        assert reject.kind == POST_CLOSE_REJECT_GAP_FILL
        err = reject.message
        assert "补跑一次最多" in err
        assert str(MAX_GAP_FILL_ADDS) in err
    finally:
        clear_active_coordination("exec-post-close")


def test_post_close_force_scope_escapes():
    """点名放行本闸（force=["post_close"]）：收口后大扇出仍放行。"""
    err = post_close_cold_open_error(
        _tool(origin=EXECUTION_HARVEST_ORIGIN, force=True),
        _substantial_unnamed(n=4),
    )
    assert err is None


def test_post_close_other_gate_scope_does_not_escape():
    """逐闸：放行同构/换马甲闸不顺手打开收口闸。"""
    t = _tool(origin=EXECUTION_HARVEST_ORIGIN)
    t._force_scopes = ForceScopes(frozenset({"isomorphic", "thrash", "seat_overlap"}))
    err = post_close_cold_open_error(t, _substantial_unnamed(n=4))
    assert err is not None
    assert "收口后拒绝整团重派" in err


def test_post_close_legacy_bool_force_no_longer_escapes():
    """历史一键全开退役：force=true 解析成空集，收口闸照拒。"""
    from agentcore.runtime.delegate.force_scopes import parse_force_scopes

    t = _tool(origin=EXECUTION_HARVEST_ORIGIN)
    t._force_scopes = parse_force_scopes(True)
    err = post_close_cold_open_error(t, _substantial_unnamed(n=4))
    assert err is not None


def test_non_harvest_human_first_delegate_not_blocked():
    """真人首派：非 harvest origin 不误伤。"""
    err = post_close_cold_open_error(
        _tool(origin=""),
        _substantial_unnamed(n=5),
    )
    assert err is None


def test_trivial_batch_not_gated():
    """非 substantial（≤2 且无依赖）收口后仍可冷开。"""
    plan = RunPlan(nodes=[RunSpec(run_id="a", role="A", task="polish")])
    err = post_close_cold_open_error(
        _tool(origin=EXECUTION_HARVEST_ORIGIN),
        plan,
    )
    assert err is None


@pytest.mark.asyncio
async def test_same_graph_replan_gap_fill_unchanged():
    """同图 replan 补跑闸不回归（仍复用 MAX_GAP_FILL_ADDS）。"""
    from agentcore.runtime.delegate.supervised import apply_replan
    from agentcore.runtime.runs.types import RunPhase, RunState

    class _FakeTools:
        def list_all(self):
            return []

    class _FakeDelegate:
        _tools = _FakeTools()
        _captain_run_id = "cap"
        _depth = 0
        _topology_lock = False
        _folder_id = "test_birth"

        def effective_default_target_folder_id(self) -> str | None:
            return None

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="ok", role="A", task="done"),
            *[RunSpec(run_id=f"f{i}", role=f"B{i}", task=f"fail{i}") for i in range(1, 5)],
        ]
    )
    completed = {
        "ok": RunState(phase=RunPhase.COMPLETED, content="ok"),
        **{f"f{i}": RunState(phase=RunPhase.FAILED, error="e") for i in range(1, 5)},
    }
    too_many = [
        {"role": f"R{i}", "task": f"retry {i}", "replaces_run_id": f"f{i}"}
        for i in range(1, 5)
    ]
    err = await apply_replan(
        _FakeDelegate(), plan, completed, binds=[], steers=[], adds=too_many
    )
    assert err
    assert any("补跑一次最多" in e for e in err)
    assert any(str(MAX_GAP_FILL_ADDS) in e for e in err)


@pytest.mark.asyncio
async def test_drive_post_close_unnamed_substantial_contract_reject():
    """drive 冷开准入：harvest origin + 未点名 substantial → contract_failure。"""
    from agentcore.runtime.coordination.session import clear_active_coordination
    from agentcore.runtime.events import EventSink
    from tests.delegate.conftest import ctx, tool
    from tests.delegate.test_coordination_secondary_delegate import _SlowWorkers

    clear_active_coordination()
    sink = EventSink()
    t = tool(_SlowWorkers(["ok", "ok", "ok"], delay=0.01), sink=sink)
    t._user_message_origin = EXECUTION_HARVEST_ORIGIN

    from structlog.testing import capture_logs

    with capture_logs() as logs:
        result = await t.execute(
            {
                "tasks": [
                    {"role": "A", "task": "one"},
                    {"role": "B", "task": "two"},
                    {"role": "C", "task": "three"},
                ],
                "coordinate": False,
            },
            ctx(),
        )
    assert result.success is False
    assert result.contract_failure is True
    assert "收口后拒绝整团重派" in (result.error or "")
    events = [e.get("event") for e in logs]
    assert "delegate.post_close_redelegation_rejected" in events
    assert "delegate.post_close_gap_fill_rejected" not in events
    hit = next(
        e for e in logs if e.get("event") == "delegate.post_close_redelegation_rejected"
    )
    assert hit.get("kind") == POST_CLOSE_REJECT_COLD_OPEN
    assert "收口后拒绝整团重派" in (hit.get("error") or "")
    clear_active_coordination()


@pytest.mark.asyncio
async def test_drive_post_close_force_allows_substantial():
    """drive：点名放行收口闸后，收口后大扇出通过。"""
    from agentcore.runtime.coordination.session import clear_active_coordination
    from agentcore.runtime.events import EventSink
    from tests.delegate.conftest import ctx, tool
    from tests.delegate.test_coordination_secondary_delegate import _SlowWorkers

    clear_active_coordination()
    sink = EventSink()
    t = tool(_SlowWorkers(["ok", "ok", "ok"], delay=0.01), sink=sink)
    t._user_message_origin = EXECUTION_HARVEST_ORIGIN

    result = await t.execute(
        {
            "tasks": [
                {"role": "A", "task": "one"},
                {"role": "B", "task": "two"},
                {"role": "C", "task": "three"},
            ],
            "coordinate": False,
            "force": ["post_close"],
        },
        ctx(),
    )
    assert result.success is True
    clear_active_coordination()


@pytest.mark.asyncio
async def test_drive_post_close_gap_fill_over_cap_emits_distinct_event():
    """drive 补跑超限：事件名与冷开整团拒分轨，且带 error 正文。"""
    from structlog.testing import capture_logs

    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        clear_active_coordination,
        set_active_coordination,
    )
    from agentcore.runtime.events import EventSink
    from tests.delegate.conftest import ctx, tool
    from tests.delegate.test_coordination_secondary_delegate import _SlowWorkers

    clear_active_coordination()
    session = CoordinationSession(execution_id="e", total_workers=1)
    session.conversation_id = "c"
    session.completed_run_ids = {"f1"}
    session.failed_run_ids = {"f1"}
    session.active = False
    set_active_coordination(session)
    try:
        sink = EventSink()
        t = tool(_SlowWorkers(["ok", "ok"], delay=0.01), sink=sink)
        t._user_message_origin = EXECUTION_HARVEST_ORIGIN
        with capture_logs() as logs:
            result = await t.execute(
                {
                    "tasks": [
                        {"role": "A", "task": "retry1", "replaces_run_id": "f1"},
                        {"role": "B", "task": "retry2", "replaces_run_id": "f1"},
                    ],
                    "coordinate": False,
                },
                ctx(),
            )
        assert result.success is False
        assert result.contract_failure is True
        assert "补跑一次最多" in (result.error or "")
        events = [e.get("event") for e in logs]
        assert "delegate.post_close_gap_fill_rejected" in events
        assert "delegate.post_close_redelegation_rejected" not in events
        hit = next(
            e for e in logs if e.get("event") == "delegate.post_close_gap_fill_rejected"
        )
        assert hit.get("kind") == POST_CLOSE_REJECT_GAP_FILL
        assert "补跑一次最多" in (hit.get("error") or "")
    finally:
        clear_active_coordination("e")


@pytest.mark.asyncio
async def test_drive_post_close_empty_roster_replaces_still_rejected_on_foreground():
    """前台 session is None：空名册 + replaces 仍拒（闸判定与拒绝范围未改）。"""
    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        clear_active_coordination,
        set_active_coordination,
    )
    from agentcore.runtime.events import EventSink
    from tests.delegate.conftest import ctx, tool
    from tests.delegate.test_coordination_secondary_delegate import _SlowWorkers

    clear_active_coordination()
    session = CoordinationSession(execution_id="e", total_workers=1)
    session.conversation_id = "c"
    session.active = False
    set_active_coordination(session)
    try:
        sink = EventSink()
        t = tool(_SlowWorkers(["ok"], delay=0.01), sink=sink)
        t._user_message_origin = EXECUTION_HARVEST_ORIGIN
        result = await t.execute(
            {
                "tasks": [
                    {"role": "A", "task": "retry f1", "replaces_run_id": "f1"},
                ],
                "coordinate": False,
            },
            ctx(),
        )
        assert result.success is False
        assert result.contract_failure is True
        assert "无缺口" in (result.error or "")
    finally:
        clear_active_coordination("e")


@pytest.mark.asyncio
async def test_drive_coordinated_skips_post_close_reentry_on_empty_roster():
    """后台带 session：不重跑 post_close（空名册会把已准入的 replaces 误拒）。"""
    from structlog.testing import capture_logs

    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        clear_active_coordination,
        set_active_coordination,
    )
    from agentcore.runtime.delegate.drive import drive_coordinated
    from agentcore.runtime.events import EventSink
    from agentcore.runtime.runs import build_run_plan
    from tests.delegate.conftest import tool
    from tests.delegate.test_coordination_secondary_delegate import _SlowWorkers

    clear_active_coordination()
    session = CoordinationSession(execution_id="e", total_workers=1)
    session.conversation_id = "c"
    set_active_coordination(session)
    try:
        sink = EventSink()
        t = tool(_SlowWorkers(["retry-ok"], delay=0.01), sink=sink)
        t._user_message_origin = EXECUTION_HARVEST_ORIGIN
        plan, errors = build_run_plan(
            [{"role": "A", "task": "retry f1", "replaces_run_id": "f1"}]
        )
        assert not errors
        with capture_logs() as logs:
            result = await drive_coordinated(
                t,
                plan,
                execution_id="e",
                seed_completed=None,
                seed_notes=None,
                complexity_hint="standard",
                coordination="none",
                call_idx=0,
                session=session,
            )
        events = [e.get("event") for e in logs]
        assert "delegate.post_close_gap_fill_rejected" not in events
        assert result.success is True
        assert len(session.completed_run_ids) >= 1
    finally:
        clear_active_coordination("e")


@pytest.mark.asyncio
async def test_coordinate_background_does_not_rerun_post_close_after_admit():
    """前台已过 post_close 后，后台不得拿刚建的空名册再拒 replaces。"""
    from structlog.testing import capture_logs

    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        active_coordination,
        clear_active_coordination,
        set_active_coordination,
    )
    from agentcore.runtime.events import EventSink
    from tests.delegate.conftest import ctx, tool
    from tests.delegate.test_coordination_secondary_delegate import _SlowWorkers

    clear_active_coordination()
    prior = CoordinationSession(execution_id="e", total_workers=1)
    prior.conversation_id = "c"
    prior.completed_run_ids = {"f1"}
    prior.failed_run_ids = {"f1"}
    prior.active = False
    set_active_coordination(prior)
    try:
        sink = EventSink()
        t = tool(_SlowWorkers(["retry-ok"], delay=0.01), sink=sink)
        t._user_message_origin = EXECUTION_HARVEST_ORIGIN
        with capture_logs() as logs:
            result = await t.execute(
                {
                    "tasks": [
                        {"role": "A", "task": "retry f1", "replaces_run_id": "f1"},
                    ],
                    "coordinate": True,
                },
                ctx(),
            )
            assert result.success is True
            assert "团队已启动" in result.output
            session = active_coordination("e")
            assert session is not None
            assert session.drive_task is not None
            await asyncio.wait_for(session.drive_task, timeout=10)
        events = [e.get("event") for e in logs]
        assert "delegate.post_close_gap_fill_rejected" not in events
        assert len(session.completed_run_ids) >= 1
    finally:
        clear_active_coordination("e")
