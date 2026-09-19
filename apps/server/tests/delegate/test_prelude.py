"""委派前奏单测：硬拒 / 规范化，不经整条执行链。

`resolve_delegate_prelude` 从 `DelegateTool.execute` 抽出后是纯函数（零 await、不写实例），
这里直接喂 `arguments` 断言这几道闸——不用 mock LLM / 调度 / 协作图。
"""

from __future__ import annotations

import agentcore.runtime.delegate.prelude as prelude_mod
from agentcore.core.errors import LLMAuthError
from agentcore.llm.turn_auth_dead import (
    bind_turn_auth_dead,
    mark_turn_auth_dead,
    reset_turn_auth_dead,
)
from agentcore.runtime.delegate.prelude import (
    DelegateBatchRequest,
    DelegatePreludeReject,
    resolve_delegate_prelude,
)
from agentcore.runtime.runs.constants import MAX_WORKER_SUBDELEGATIONS
from agentcore.runtime.turn.token_budget import (
    bind_turn_token_meter,
    record_turn_tokens,
    reset_turn_token_meter,
    resolve_turn_token_ceiling,
)
from agentcore.tools.registry import ToolRegistry
from tests.conftest import LogSpy


def run(arguments: dict, **over):
    """Call the prelude with test defaults (root captain, empty tool surface)."""
    kwargs = {
        "tools": ToolRegistry(),
        "depth": 0,
        "sub_workers_spawned": 0,
        "credential_source": "user",
    }
    kwargs.update(over)
    return resolve_delegate_prelude(arguments, **kwargs)


def accepted(arguments: dict, **over) -> DelegateBatchRequest:
    out = run(arguments, **over)
    assert isinstance(out, DelegateBatchRequest), getattr(out, "result", out)
    return out


def rejected(arguments: dict, **over) -> DelegatePreludeReject:
    out = run(arguments, **over)
    assert isinstance(out, DelegatePreludeReject)
    assert out.result.success is False
    return out


_ONE_TASK = [{"role": "工程师", "task": "做A"}]


# ── 硬拒 ──────────────────────────────────────────────────────────────────────


def test_turn_token_ceiling_rejects_before_anything_else(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    token = bind_turn_token_meter(seed=0)
    try:
        record_turn_tokens(resolve_turn_token_ceiling() + 1)
        out = rejected({"tasks": _ONE_TASK})
    finally:
        reset_turn_token_meter(token)
    assert out.result.contract_failure is True
    assert spy.get("delegate.turn_token_ceiling_rejected")["ceiling"] == (
        resolve_turn_token_ceiling()
    )


def test_turn_auth_dead_rejects(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    token = bind_turn_auth_dead()
    try:
        mark_turn_auth_dead(LLMAuthError(provider_name="user"))
        out = rejected({"tasks": _ONE_TASK})
    finally:
        reset_turn_auth_dead(token)
    assert out.result.contract_failure is True
    assert spy.get("delegate.turn_auth_dead_rejected") == {}


def test_turn_auth_dead_other_source_does_not_reject(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    token = bind_turn_auth_dead()
    try:
        mark_turn_auth_dead(LLMAuthError(provider_name="platform"))
        accepted({"tasks": _ONE_TASK})
    finally:
        reset_turn_auth_dead(token)
    assert "delegate.turn_auth_dead_rejected" not in [n for n, _ in spy.events]


def test_empty_tasks_rejected(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    from agentcore.tools.builtin.delegate.schema import (
        EMPTY_DELEGATE_MSG,
        HANDWRITTEN_TASKS_SKELETON,
    )

    out = rejected({})
    assert out.result.error == EMPTY_DELEGATE_MSG
    assert HANDWRITTEN_TASKS_SKELETON in (out.result.error or "")
    assert out.result.contract_failure is True
    assert spy.get("delegate.empty_rejected")["has_tasks"] is False

    empty_list = rejected({"tasks": []})
    assert empty_list.result.error == EMPTY_DELEGATE_MSG
    assert empty_list.result.contract_failure is True


def test_unknown_top_level_keys_do_not_expand_or_xor():
    """未知顶层键不展开、不 XOR；没有 tasks 仍是缺 tasks，同传手写 tasks 照收。"""
    from agentcore.tools.builtin.delegate.schema import EMPTY_DELEGATE_MSG

    out = rejected({"playbook": "cite_write_review"})
    assert out.result.error == EMPTY_DELEGATE_MSG

    batch = accepted({"playbook": "cite_write_review", "tasks": _ONE_TASK})
    assert batch.tasks_raw == _ONE_TASK


def test_sub_fanout_cap_rejected_at_depth(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    tasks = [{"role": f"r{i}", "task": f"t{i}"} for i in range(MAX_WORKER_SUBDELEGATIONS)]
    out = rejected(
        {"tasks": tasks},
        depth=1,
        sub_workers_spawned=1,
    )
    assert "子团队扇出已达上限" in (out.result.error or "")
    assert "分批" not in (out.result.error or "")
    # 扇出拒绝不是契约自纠打回（保持原样：不设 contract_failure）。
    assert out.result.contract_failure is False
    logged = spy.get("delegate.sub_fanout_rejected")
    assert logged["spawned"] == 1
    assert logged["requested"] == MAX_WORKER_SUBDELEGATIONS
    assert logged["cap"] == MAX_WORKER_SUBDELEGATIONS


def test_sub_fanout_within_cap_passes():
    out = accepted({"tasks": _ONE_TASK}, depth=1, sub_workers_spawned=1)
    assert len(out.tasks_raw) == 1


# ── 规范化 ────────────────────────────────────────────────────────────────────


def test_handwritten_tasks_normalized():
    tools = ToolRegistry()
    out = accepted({"tasks": _ONE_TASK}, tools=tools)
    assert out.tasks_raw == _ONE_TASK
    assert out.valid_tools == {s.name for s in tools.list_all()}


def test_single_dependency_free_worker_infers_light(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    out = accepted(
        {
            "tasks": [
                {
                    "role": "工程师",
                    "task": "做A",
                    "deliverable": {"form": "prose"},
                }
            ]
        }
    )
    assert out.complexity_hint == "light"
    assert spy.get("delegate.complexity_hint_inferred")["hint"] == "light"


def test_omitted_deliverable_single_worker_infers_light():
    """Omitted / empty deliverable auto-lights a single dependency-free worker."""
    out = accepted({"tasks": _ONE_TASK})
    assert out.complexity_hint == "light"


def test_explicit_hint_is_never_auto_inferred():
    out = accepted({"tasks": _ONE_TASK, "complexity_hint": "standard"})
    assert out.complexity_hint == "standard"


def test_explicit_light_ignored_when_wave_boundary_present(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    out = accepted(
        {
            "tasks": [
                {"id": "s1", "role": "研究员", "task": "调研"},
                {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
            ],
            "complexity_hint": "light",
        }
    )
    assert out.complexity_hint == "standard"
    assert spy.get("delegate.complexity_hint_ignored")["reason"] == "wave_boundary_features"


def test_deep_deliverable_single_worker_stays_standard():
    out = accepted(
        {
            "tasks": [
                {
                    "role": "工程师",
                    "task": "实现功能并落盘",
                    "deliverable": {"form": "files", "artifacts": ["src/main.py"]},
                }
            ]
        }
    )
    assert out.complexity_hint == "standard"


# ── 一次性软提示族已撤（同形入参仍接受，无告警字段、无事件）──────────────────


def test_former_soft_scan_shapes_accepted_without_warn_fields_or_events(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(prelude_mod, "logger", spy)
    goldbach = accepted(
        {
            "tasks": [
                {"id": "r1", "role": "调研甲", "task": "调研偶数哥德巴赫猜想相关文献"},
                {"id": "r2", "role": "调研乙", "task": "调研奇数哥德巴赫猜想相关文献"},
                {"id": "s", "role": "汇总", "task": "基于前两位队员的产出，整理一份综述报告"},
            ]
        }
    )
    mixed = accepted(
        {
            "tasks": [
                {
                    "id": "fs",
                    "role": "全栈工程师",
                    "task": "新建桌面 AI 编程助手 MVP 骨架",
                    "deliverable": {
                        "form": "files",
                        "artifacts": [
                            "agent-editor/DESIGN.md",
                            "agent-editor/package.json",
                            "agent-editor/src/main.ts",
                        ],
                    },
                }
            ]
        }
    )
    root_ws = accepted(
        {
            "tasks": [
                {
                    "role": "工程师",
                    "task": "从零实现应用 MVP",
                    "deliverable": {"form": "workspace"},
                }
            ]
        }
    )
    nested = accepted(
        {
            "tasks": [
                {
                    "role": "工程师",
                    "task": "从零实现应用 MVP",
                    "deliverable": {"form": "workspace"},
                }
            ]
        },
        depth=1,
    )
    for out in (goldbach, mixed, root_ws, nested):
        assert not hasattr(out, "consumer_deps_warn")
        assert not hasattr(out, "design_impl_warn")
        assert not hasattr(out, "root_slice_warn")
    names = [n for n, _ in spy.events]
    assert "delegate.consumer_deps_soft_warn" not in names
    assert "delegate.design_impl_same_grant_soft_warn" not in names
    assert "delegate.root_slice_honesty_soft_warn" not in names


def test_declared_depends_still_accepted():
    out = accepted(
        {
            "tasks": [
                {"id": "r1", "role": "调研", "task": "查资料"},
                {"id": "w1", "role": "写手", "task": "成文", "depends_on": ["r1"]},
            ]
        }
    )
    assert isinstance(out, DelegateBatchRequest)
    assert not hasattr(out, "consumer_deps_warn")
