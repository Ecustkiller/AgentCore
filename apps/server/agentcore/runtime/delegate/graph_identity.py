"""协作图身份解析：这批 task 挂到哪张协作图上。

从 `DelegateTool.execute` 抽出（纯搬运）。只回答「合入哪张图 / 新开哪张图」，
不建 plan、不发事件、不写工具实例——产出 :class:`GraphIdentity`，或一条硬拒。

三条出路（与 `graph_append` 的宿主查找配套）：

- 同回合二次派发（含用户插话触发的）→ 合入本回合当前图（内部 ``append_to``，不写 prev）
- 跨回合且上一张仍在跑，或点名 ``continue_from_run_id`` / ``replaces_run_id``
  → 本回合新图 + ``prev_execution_id``
- 跨回合已收口且无续派 / 补缺口 → 新图、不链

图归属由回合边界机械决定。观测领养（wait / cancel / 插话）走
``current_execution_id``，派单落图走本回合 mint 的 ``context_execution_id``。

模块内经 ``coordination_session.`` / ``graph_append.`` 属性调用（而非 from-import 绑名），
保持调用点晚绑定。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.runtime.coordination import session as coordination_session
from agentcore.runtime.delegate import graph_append
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunState

logger = get_logger(__name__)


def _is_same_host_turn_append(active: Any, message_id: str | None) -> bool:
    """True only for same-turn secondary delegate (message_id ≡ host_turn_id).

    Cross-turn adopt keeps the previous live graph for observation, but this
    turn's message_id differs from ``host_turn_id`` — that path mints a new graph
    + ``prev_execution_id``. Empty / unbound ``host_turn_id`` is not same-turn.
    """
    host_tid = (getattr(active, "host_turn_id", None) or "").strip()
    cur_tid = (message_id or "").strip()
    return bool(host_tid) and host_tid == cur_tid


def _is_live_execution_merge(active: Any, append_to: str | None) -> bool:
    """True when ``append_to`` targets a still-active coordination session."""
    if active is None or not getattr(active, "active", False):
        return False
    eid = (append_to or "").strip()
    if not eid:
        return False
    return eid == (getattr(active, "execution_id", None) or "").strip()


def _observation_session(
    *,
    context_execution_id: str | None,
    conversation_id: str | None,
) -> Any:
    """Live session for wait/control — may differ from this turn's mint eid.

    Prefer the ContextVar (adopt) / conversation registry over the mint id, so a
    still-running previous graph remains findable after a new turn starts.
    """
    via_var = coordination_session.active_coordination()
    if via_var is not None and getattr(via_var, "active", False):
        return via_var
    cid = (conversation_id or "").strip()
    if cid:
        via_conv = coordination_session.active_coordination_for_conversation(cid)
        if via_conv is not None and getattr(via_conv, "active", False):
            return via_conv
    return coordination_session.active_coordination(context_execution_id)


def _is_same_turn_merge(
    active: Any,
    *,
    message_id: str | None,
    calls: int,
    context_execution_id: str | None = None,
    last_graph_execution_id: str | None = None,
) -> bool:
    """合入仅限同回合：宿主 message_id 对上，或本工具实例二次+ 命中本回合图。"""
    if active is None or not getattr(active, "active", False):
        return False
    if _is_same_host_turn_append(active, message_id):
        return True
    if calls < 1:
        return False
    eid = (getattr(active, "execution_id", None) or "").strip()
    if not eid:
        return False
    mint = (context_execution_id or "").strip()
    last = (last_graph_execution_id or "").strip()
    return eid in (mint, last)


def _tasks_continue_or_replace(arguments: dict[str, Any]) -> bool:
    """True when any task names a person-level continue / gap-fill run."""
    tasks = arguments.get("tasks")
    if not isinstance(tasks, list):
        return False
    for item in tasks:
        if not isinstance(item, dict):
            continue
        if str(item.get("continue_from_run_id") or "").strip():
            return True
        if str(item.get("replaces_run_id") or "").strip():
            return True
    return False


@dataclass(frozen=True)
class GraphIdentity:
    """本批 task 的协作图归属（`execute` 直接摊到同名局部变量上）。"""

    append_to: str | None = None
    prev_execution_id: str | None = None
    append_seed: dict | None = None
    host_plan_for_append: RunPlan | None = None
    host_captain_run_id: str | None = None


async def resolve_graph_identity(
    arguments: dict[str, Any],
    *,
    depth: int,
    context_execution_id: str | None,
    message_id: str | None,
    conversation_id: str | None,
    captain_run_id: str | None,
    calls: int,
    last_graph_execution_id: str | None,
    last_graph_plan: RunPlan | None,
    last_graph_seed: dict[str, RunState] | None,
) -> GraphIdentity | ToolResult:
    """解析协作图身份，或返回硬拒 ToolResult。

    ``calls`` / ``last_graph_*`` = 工具实例上的同回合上一张图快照（`_calls` /
    `_last_graph_execution_id` / `_last_graph_plan` / `_last_graph_seed`）。
    """
    append_to: str | None = None
    prev_execution_id: str | None = None
    append_seed: dict | None = None
    host_plan_for_append = None

    # 同回合注入 existing_plan：活跃 live_plan；否则本 tool 实例二次+ 合入上一张图。
    # 跨回合默认新图——仅同回合（活跃 session / _calls≥1）自动合入。
    active = coordination_session.active_coordination(context_execution_id)
    if (
        active is not None
        and active.active
        and getattr(active, "live_plan", None) is not None
        and _is_same_turn_merge(
            active,
            message_id=message_id,
            calls=calls,
            context_execution_id=context_execution_id,
            last_graph_execution_id=last_graph_execution_id,
        )
    ):
        host_plan_for_append = active.live_plan
    elif calls >= 1:
        last_eid = last_graph_execution_id
        last_plan = last_graph_plan
        if isinstance(last_eid, str) and last_eid.strip():
            append_to = last_eid.strip()
            # 同回合内存宿主：无 journal 亦可合入（阻塞单人跑完常见）。
            if last_plan is not None:
                host_plan_for_append = last_plan
                last_seed = last_graph_seed
                if last_seed is not None:
                    append_seed = last_seed

    host_captain_run_id: str | None = None
    if append_to:
        memory_host = host_plan_for_append is not None
        active = coordination_session.active_coordination(
            append_to
        ) or coordination_session.active_coordination(context_execution_id)
        same_turn = _is_same_turn_merge(
            active,
            message_id=message_id,
            calls=calls,
            context_execution_id=context_execution_id,
            last_graph_execution_id=last_graph_execution_id,
        ) or (memory_host and calls >= 1)
        live_merge = same_turn and (
            _is_live_execution_merge(active, append_to) or memory_host
        )

        if live_merge and host_plan_for_append is None and active is not None:
            host_plan_for_append = getattr(active, "live_plan", None)
        if not live_merge or host_plan_for_append is None:
            msg = (
                f"既有协作图 `{append_to}` 缺少可合并的计划快照（plan_snapshot），"
                "无法合入。请新建团队执行。"
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=msg,
                contract_failure=True,
            )
        host_captain_run_id = graph_append.parse_host_captain_run_id(
            await graph_append.load_host_journal_entries(
                (getattr(active, "host_turn_id", None) or "")
                if active is not None
                else ""
            )
        ) or captain_run_id

    # 跨回合首派：机械链回上一张（观测领养的 live 图，或 continue_from / replaces）。
    if (
        host_plan_for_append is None
        and not append_to
        and not prev_execution_id
        and calls == 0
        and depth == 0
    ):
        observed = _observation_session(
            context_execution_id=context_execution_id,
            conversation_id=conversation_id,
        )
        observed_eid = (
            (getattr(observed, "execution_id", None) or "").strip()
            if observed is not None and getattr(observed, "active", False)
            else ""
        )
        mint = (context_execution_id or "").strip()
        if (
            observed_eid
            and observed_eid != mint
            and not _is_same_host_turn_append(observed, message_id)
        ):
            prev_execution_id = observed_eid
            logger.info(
                "delegate.graph_prev",
                conversation_id=conversation_id or "",
                prev_execution_id=prev_execution_id,
                host_message_id=(
                    getattr(observed, "host_turn_id", None) or ""
                ),
                via="turn_boundary",
            )
        elif _tasks_continue_or_replace(arguments):
            resolved = await graph_append.resolve_latest_appendable_execution(
                conversation_id=conversation_id or "",
                prefer_message_id=message_id,
            )
            if resolved and resolved != mint:
                prev_execution_id = resolved
                logger.info(
                    "delegate.graph_prev",
                    conversation_id=conversation_id or "",
                    prev_execution_id=prev_execution_id,
                    via="continue_from_run",
                )

    return GraphIdentity(
        append_to=append_to,
        prev_execution_id=prev_execution_id,
        append_seed=append_seed,
        host_plan_for_append=host_plan_for_append,
        host_captain_run_id=host_captain_run_id,
    )
