"""协作图身份解析单测：合入热图 / prev 链 / 同回合内存宿主。

`resolve_graph_identity` 从 `DelegateTool.execute` 抽出后只吃显式入参（不摸工具实例），
这里直接喂参数断言归属判定——不用起 LLM、不用跑调度。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import agentcore.runtime.delegate.graph_identity as gi_mod
from agentcore.runtime.delegate.graph_identity import GraphIdentity, resolve_graph_identity
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.tools.protocol import ToolResult
from tests.conftest import LogSpy

pytestmark = pytest.mark.asyncio


async def resolve(arguments: dict, **over):
    kwargs = {
        "depth": 0,
        "context_execution_id": "e-ctx",
        "message_id": "m-now",
        "conversation_id": "conv-1",
        "captain_run_id": "cap-1",
        "calls": 0,
        "last_graph_execution_id": None,
        "last_graph_plan": None,
        "last_graph_seed": None,
    }
    kwargs.update(over)
    return await resolve_graph_identity(arguments, **kwargs)


async def identity(arguments: dict, **over) -> GraphIdentity:
    out = await resolve(arguments, **over)
    assert isinstance(out, GraphIdentity), getattr(out, "error", out)
    return out


async def rejected(arguments: dict, **over) -> ToolResult:
    out = await resolve(arguments, **over)
    assert isinstance(out, ToolResult)
    assert out.success is False
    return out


def _plan(run_id: str = "r1") -> RunPlan:
    return RunPlan(nodes=[RunSpec(run_id=run_id, task="调研", role="研究员", agent_id="w1")])


def _session(execution_id: str, *, live_plan=None, host_turn_id: str = "", active: bool = True):
    """Minimal stand-in for CoordinationSession (只用到这四个字段)。"""
    return SimpleNamespace(
        execution_id=execution_id,
        active=active,
        live_plan=live_plan,
        host_turn_id=host_turn_id,
    )


async def _empty_journal(_host_message_id: str):
    return []


def _bind_sessions(monkeypatch, mapping: dict[str, object], *, default: object | None = None):
    def lookup(eid=None):
        key = (eid or "").strip()
        if not key:
            if default is not None:
                return default
            return mapping.get("")
        return mapping.get(key)

    monkeypatch.setattr(
        "agentcore.runtime.coordination.session.active_coordination",
        lookup,
    )


# ── 缺省：不传续派 → 新图 ──────────────────────────────────────────────────


async def test_no_continuation_argument_is_a_fresh_graph():
    assert await identity({}) == GraphIdentity()


# ── 同回合合入 ─────────────────────────────────────────────────────────────


async def test_second_call_auto_merges_into_last_graph(monkeypatch):
    monkeypatch.setattr(
        gi_mod.graph_append, "load_host_journal_entries", _empty_journal
    )
    plan = _plan()
    seed = {"r1": RunState(phase=RunPhase.COMPLETED, content="")}
    out = await identity(
        {},
        calls=1,
        last_graph_execution_id="exec-live",
        last_graph_plan=plan,
        last_graph_seed=seed,
    )
    assert out.append_to == "exec-live"
    assert out.host_plan_for_append is plan
    assert out.append_seed is seed
    assert out.host_captain_run_id == "cap-1"
    assert out.prev_execution_id is None


async def test_first_call_never_auto_merges_across_turns():
    out = await identity(
        {},
        calls=0,
        last_graph_execution_id="exec-live",
        last_graph_plan=_plan(),
    )
    assert out == GraphIdentity()


async def test_same_turn_live_host_merges_plan(monkeypatch):
    """同回合热图：合入本回合图，不写 prev。"""
    plan = _plan()
    _bind_sessions(
        monkeypatch,
        {"e-host": _session("e-host", live_plan=plan, host_turn_id="m-now")},
    )
    out = await identity({}, context_execution_id="e-host")
    assert out.host_plan_for_append is plan
    assert out.prev_execution_id is None
    assert out.append_to is None


async def test_second_call_without_plan_snapshot_rejects(monkeypatch):
    monkeypatch.setattr(
        "agentcore.runtime.coordination.session.active_coordination",
        lambda *_a, **_k: None,
    )
    out = await rejected(
        {},
        calls=1,
        last_graph_execution_id="exec-live",
        last_graph_plan=None,
    )
    assert "缺少可合并的计划快照" in (out.error or "")
    assert out.contract_failure is True


# ── 跨回合 prev 链 ─────────────────────────────────────────────────────────


async def test_adopted_live_session_does_not_merge_on_first_call(monkeypatch):
    """adopt 热图仍在跑：本回合首派新开并链 prev，不合入旧图。"""
    spy = LogSpy()
    monkeypatch.setattr(gi_mod, "logger", spy)
    plan = _plan()
    live = _session("e-old", live_plan=plan, host_turn_id="m-earlier")
    _bind_sessions(monkeypatch, {"e-old": live}, default=live)
    out = await identity({}, calls=0, context_execution_id="e-new")
    assert out.prev_execution_id == "e-old"
    assert out.append_to is None
    assert out.host_plan_for_append is None
    assert spy.get("delegate.graph_prev")["via"] == "turn_boundary"


async def test_continue_from_run_id_auto_prev(monkeypatch):
    """点名续派人时自动写 prev，不必模型点名图。"""
    spy = LogSpy()
    monkeypatch.setattr(gi_mod, "logger", spy)

    async def latest(*, conversation_id: str, prefer_message_id: str | None):
        assert conversation_id == "conv-1"
        return "exec-prior"

    monkeypatch.setattr(
        gi_mod.graph_append, "resolve_latest_appendable_execution", latest
    )
    out = await identity(
        {
            "tasks": [
                {
                    "role": "撰写员",
                    "task": "接着写",
                    "continue_from_run_id": "r1",
                }
            ]
        },
        context_execution_id="e-new",
    )
    assert out.prev_execution_id == "exec-prior"
    assert out.append_to is None
    assert spy.get("delegate.graph_prev")["via"] == "continue_from_run"


async def test_replaces_run_id_auto_prev(monkeypatch):
    async def latest(**_k):
        return "exec-prior"

    monkeypatch.setattr(
        gi_mod.graph_append, "resolve_latest_appendable_execution", latest
    )
    out = await identity(
        {
            "tasks": [
                {"role": "补位", "task": "补缺口", "replaces_run_id": "r-fail"}
            ]
        },
        context_execution_id="e-new",
    )
    assert out.prev_execution_id == "exec-prior"
    assert out.append_to is None
