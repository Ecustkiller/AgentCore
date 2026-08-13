"""Turn-scoped queue for ambient debate steering (老板随时插手).

While ``debate`` drives, the Moderator coroutine runs continuously — user mid-flight
steer must arrive on a separate channel (same pattern as
:mod:`agentcore.runtime.runs.redirect_queue`). This module holds pending structured
``(execution_id, decision, focus, ask, ask_target)`` requests until the Moderator
drains them at the **next round boundary** (non-blocking).

Steer window（谁能收、收到什么时候）——一个 execution 只在【还会再走到一个轮次边界】
的这段时间里收 steer，由 :class:`~agentcore.tools.builtin.debate.tool.DebateTool` 用
:func:`open_steer_window` / :func:`close_steer_window` 圈定：开赛（主持人开跑）开窗，
最后一轮边界一过（裁判判收敛 / 用户 conclude / 触轮数上限）立刻关窗，回合出任何口
（含崩溃）在 ``finally`` 兜底关。关窗后 :func:`enqueue_steer` **返回 None = 明确不收**，
路由据此回诚实回执，而不是照样答「已发送·下一轮生效」——末轮之后的结辩 + 简报可达数
十秒，那期间入的队永远没有边界来捞它。关窗同时丢弃残留条目（进程内 dict 不再常驻）。

Drain semantics:
- empty → ``None`` (judge auto-convergence continues)
- any ``conclude`` → ``CONCLUDE`` (last ask kept for unanswered record)
- else → ``CONTINUE`` (last non-empty focus; last ask + target)
- never blocks; conclude applies at the next boundary (current round finishes first)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DebateSteerDecision = Literal["continue", "conclude"]


@dataclass(frozen=True, slots=True)
class DebateSteerRequest:
    execution_id: str
    conversation_id: str
    decision: DebateSteerDecision
    focus: str = ""
    ask: str = ""
    ask_target: str = ""


# key 存在 = 该 execution 的掌舵窗口开着（值 = 待捞条目）；无 key = 不收。
_pending: dict[str, list[DebateSteerRequest]] = {}


def open_steer_window(execution_id: str) -> None:
    """Start accepting steers for ``execution_id`` (idempotent; keeps queued items)."""
    _pending.setdefault(execution_id.strip(), [])


def close_steer_window(execution_id: str) -> int:
    """Stop accepting steers and drop whatever is still queued. Returns dropped count.

    Called by the debate tool once no further round boundary will drain the queue.
    Idempotent — a closed / unknown execution reports 0 dropped.
    """
    return len(_pending.pop(execution_id.strip(), []))


def steer_window_open(execution_id: str) -> bool:
    """Whether ``execution_id`` still has a round boundary ahead to drain steers."""
    return execution_id.strip() in _pending


def enqueue_steer(
    *,
    execution_id: str,
    conversation_id: str,
    decision: DebateSteerDecision,
    focus: str = "",
    ask: str = "",
    ask_target: str = "",
) -> DebateSteerRequest | None:
    """Queue an ambient steer for the given debate execution.

    Returns the enqueued item, or ``None`` when the window is closed (no live debate,
    or the debate is already past its last round boundary) — the caller must report
    that rejection to the user instead of echoing「已发送」.
    """
    item = DebateSteerRequest(
        execution_id=execution_id.strip(),
        conversation_id=conversation_id.strip(),
        decision=decision,
        focus=focus.strip(),
        ask=ask.strip(),
        ask_target=ask_target.strip(),
    )
    bucket = _pending.get(item.execution_id)
    if bucket is None:
        return None
    bucket.append(item)
    return item


def take_steers(execution_id: str) -> list[DebateSteerRequest]:
    """Drain and return all pending steers for ``execution_id`` (FIFO). Never blocks.

    Leaves the window open — draining is a round boundary passing, not the end of the
    debate; only :func:`close_steer_window` stops acceptance.
    """
    bucket = _pending.get(execution_id.strip())
    if not bucket:
        return []
    drained = list(bucket)
    bucket.clear()
    return drained


def peek_steer_count(execution_id: str) -> int:
    """How many steers are queued for ``execution_id`` (does not drain)."""
    return len(_pending.get(execution_id.strip(), []))


def fold_steers(steers: list[DebateSteerRequest]):
    """Fold drained steers into one :class:`~agentcore.runtime.debate.types.RoundBoundary` or None.

    Last-wins for focus / ask; any ``conclude`` wins the decision (凌驾裁判收场).
    """
    from agentcore.runtime.debate.types import RoundBoundary, RoundDecision

    if not steers:
        return None
    focus = ""
    ask = ""
    ask_target = ""
    conclude = False
    for s in steers:
        if s.focus:
            focus = s.focus
        if s.ask:
            ask = s.ask
            ask_target = s.ask_target
        if s.decision == "conclude":
            conclude = True
    if conclude:
        return RoundBoundary(
            decision=RoundDecision.CONCLUDE, ask=ask, ask_target=ask_target
        )
    return RoundBoundary(
        decision=RoundDecision.CONTINUE,
        focus=focus,
        ask=ask,
        ask_target=ask_target,
    )
