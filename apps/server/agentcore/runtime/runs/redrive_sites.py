"""Crash / infra resume windows, split from Wave's skip table.

``seed_completed`` is terminal nodes only (Wave will not re-dispatch those
ids). Unfinished workers that already have a ReAct window are passed as
:class:`ResumeHint` maps — crash keeps the journal transcript (including
in-flight ``tool_calls`` + reasoning); infra strips historical reasoning
and appends a 续干 user line.

Trailing assistant ``tool_calls`` without a matching tool message are the
in-flight write (or any tool) to replay with the **same** ``tool_call_id``.
"""

from __future__ import annotations

from collections.abc import Mapping
from contextvars import ContextVar, Token
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING

from agentcore.llm.provider.protocol import LLMMessage, ToolCall

if TYPE_CHECKING:
    from agentcore.runtime.turn.state import TurnState


class ResumeKind(StrEnum):
    """Why this run_id has a window to continue instead of a cold open."""

    CRASH = "crash"
    INFRA = "infra"


@dataclass(frozen=True, slots=True)
class ResumeHint:
    """Executor-facing resume window; never stored in Wave ``completed``."""

    kind: ResumeKind
    transcript: tuple[LLMMessage, ...]


current_resume_hints: ContextVar[dict[str, ResumeHint] | None] = ContextVar(
    "current_resume_hints", default=None
)


def window_has_react_progress(window: list[LLMMessage] | None) -> bool:
    """True when the fold has at least one assistant turn (not just run_head)."""
    return any(m.role == "assistant" for m in (window or ()))


def unmatched_trailing_tool_calls(messages: list[LLMMessage]) -> list[ToolCall]:
    """Tool calls on the last assistant message that still lack a tool result.

    A later ``user`` / ``assistant`` / ``system`` after that assistant means the
    window already moved on — do not replay (broken or 续干-appended shape).
    """
    last_asst_idx = -1
    for i, message in enumerate(messages):
        if message.role == "assistant" and message.tool_calls:
            last_asst_idx = i
    if last_asst_idx < 0:
        return []
    assistant = messages[last_asst_idx]
    seen: set[str] = set()
    for message in messages[last_asst_idx + 1 :]:
        if message.role == "tool":
            tcid = (message.tool_call_id or "").strip()
            if tcid:
                seen.add(tcid)
            continue
        if message.role in ("assistant", "user", "system"):
            return []
    calls = assistant.tool_calls or []
    return [tc for tc in calls if (tc.id or "").strip() not in seen]


def hints_from_journal(state: TurnState) -> dict[str, ResumeHint]:
    """Crash windows for unfinished workers that already have ReAct progress."""
    hints: dict[str, ResumeHint] = {}
    for run_id in state.unfinished_run_ids:
        window = state.window(run_id=run_id)
        if window_has_react_progress(window) and window is not None:
            hints[run_id] = ResumeHint(
                kind=ResumeKind.CRASH,
                transcript=tuple(window),
            )
    return hints


def bind_resume_hints(
    hints: Mapping[str, ResumeHint] | None,
) -> Token[dict[str, ResumeHint] | None]:
    return current_resume_hints.set(dict(hints) if hints else None)


def reset_resume_hints(token: Token[dict[str, ResumeHint] | None]) -> None:
    current_resume_hints.reset(token)


def get_resume_hint(run_id: str) -> ResumeHint | None:
    hints = current_resume_hints.get()
    if not hints:
        return None
    return hints.get(run_id)


def is_resume_site(run_id: str) -> bool:
    return get_resume_hint(run_id) is not None
