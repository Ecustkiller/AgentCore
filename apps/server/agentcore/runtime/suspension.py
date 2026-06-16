"""TurnSuspension — the durable snapshot of a turn paused at a client checkpoint.

结构化挂起 2b (turn 级落盘 + ``POST .../resume``): 2a suspends a turn on an
*in-memory* Future — a process restart or client disconnect loses the whole turn
(an asyncio task + any already-finished workers). This module is the inert data
layer that makes that pause **durable**: a frozen frame carrying everything
``POST .../resume`` needs to rebuild and continue the turn on a fresh process.

Two suspend points are persisted, sharing one frame via a ``kind`` discriminated
union (base :class:`TurnSuspension` + :class:`PlanReviewSuspension` /
:class:`AskUserSuspension`):

- **plan_review** — the ``WaveScheduler`` paused at a wave boundary after a
  ``checkpoint_after`` step (inside ``delegate``). Resume re-drives the remaining
  plan tail, feeds the workers' product back as the suspended ``delegate`` tool
  result, then continues the CEO loop. Carries the ``plan`` (with minted run_ids)
  + the ``completed`` seed map + the reviewed ``steps`` / gated ``pending``.
- **ask_user** — the CEO paused mid-loop on its ``ask_user`` checkpoint. Resume
  maps the user's answer to the ``ask_user`` tool result and continues the CEO
  loop (no plan tail). Carries the question / options / context / multiple of the
  card so resume can re-emit it.

Every frame shares: the CEO ``transcript`` at the pause (system + history + user +
the assistant message carrying the suspended tool_call), the ``tool_call_id`` that
result must echo (so the rebuilt transcript stays a valid tool-call/result pair),
the ``base_system_prompt`` + ``user_message`` (to re-wire the CEO toolset), the
``journal`` so far (so the resumed turn's ``messages.runs`` replays the whole
exchange), and the ``checkpoint_id`` (so resume re-emits the resolution).

The frame is captured by the suspending face (the ``delegate`` checkpoint hook /
``AskUserTool``) — both read the live CEO transcript off :data:`captain_transcript`,
published by the captain executor — and persisted by
``runtime/suspension_persistence.py``. Pure data + a contextvar here; no DB, no engine.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any, ClassVar

# NOTE: serialize helpers are imported lazily inside to_json / from_json so this
# module stays import-light (stdlib only at import time). The captain executor —
# itself imported during the ``runs`` package init — imports ``captain_transcript``
# from here, so a top-level ``runs.serialize`` import could risk an init-order cycle.

if TYPE_CHECKING:
    from agentcore.llm.protocol import LLMMessage
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunState


# The CEO captain's live message transcript for the current turn, published by the
# captain executor before it runs the ReAct loop and read by a suspending face (the
# ``delegate`` checkpoint hook / ``AskUserTool``) when it captures a suspension
# frame. A contextvar (not a parameter) because those faces are constructed by the
# pipeline and invoked deep inside the captain's loop — they have no handle on the
# messages list the loop mutates. The loop, the tool call, and the capture all run
# in the SAME asyncio task, so the task-local contextvar carries the up-to-date list
# (it holds the live reference; the capture serializes a snapshot at the pause).
# ``None`` outside a captain loop (e.g. a delegated worker's own loop, or tests) →
# the face skips durable capture.
captain_transcript: ContextVar[list[LLMMessage] | None] = ContextVar(
    "captain_transcript", default=None
)


class SuspensionKind(StrEnum):
    """Which suspend point a durable frame captured (the JSON discriminator).

    Values match the corresponding :class:`~agentcore.runtime.interaction.InteractionKind`
    so the persisted ``kind`` reads the same across the live bridge and the frame.
    Only these two suspend points are persisted (approval / client_tool stay
    in-memory — see 设计 §4.7)."""

    PLAN_REVIEW = "plan_review"
    ASK_USER = "ask_user"


@dataclass(kw_only=True)
class TurnSuspension:
    """The shared substrate of a durably-paused turn (结构化挂起 2b) — abstract base.

    Keyed (in storage) by ``message_id`` (the pipeline's minted assistant id, reused
    when the resumed turn finally persists). Concrete subclasses
    (:class:`PlanReviewSuspension` / :class:`AskUserSuspension`) add their kind's
    resume substrate and set :attr:`kind`. Everything is JSON-round-trippable
    (:meth:`to_json` / :func:`suspension_from_json`) into the ``paused_turns.frame``
    column.
    """

    # Set by each concrete subclass; written into / read from the JSON discriminator.
    kind: ClassVar[SuspensionKind]

    message_id: str
    conversation_id: str
    user_id: str
    captain_run_id: str
    # The suspended interaction's id (the ``checkpoint_id`` of the plan_review /
    # ask_user pause) — re-emitted on resume so the client flips the same card.
    checkpoint_id: str
    # The id of the suspended tool_call (``delegate`` / ``ask_user``) in the captured
    # CEO transcript; the resumed tool result must echo it so the rebuilt transcript
    # is a valid assistant-tool_call → tool-result pair.
    tool_call_id: str
    # The CLEAN base system prompt (no CEO chat hints), so the re-wired toolset hands
    # workers the SAME opening as the pre-pause ones.
    base_system_prompt: str
    user_message: str
    transcript: list[LLMMessage]
    # The team-graph journal up to and including the pause's ``*_required`` event, so
    # the resumed turn's persisted runs replay the whole graph + exchange.
    journal: list[dict[str, Any]] = field(default_factory=list)
    trace_id: str | None = None

    def _base_json(self) -> dict[str, Any]:
        """The shared fields (incl. the ``kind`` discriminator) for ``paused_turns.frame``."""
        from agentcore.runtime.runs.serialize import transcript_to_json

        return {
            "kind": self.kind.value,
            "message_id": self.message_id,
            "conversation_id": self.conversation_id,
            "user_id": self.user_id,
            "captain_run_id": self.captain_run_id,
            "checkpoint_id": self.checkpoint_id,
            "tool_call_id": self.tool_call_id,
            "base_system_prompt": self.base_system_prompt,
            "user_message": self.user_message,
            "transcript": transcript_to_json(self.transcript),
            "journal": list(self.journal),
            "trace_id": self.trace_id,
        }

    def to_json(self) -> dict[str, Any]:
        """Flatten to the JSON dict stored in ``paused_turns.frame`` (subclasses extend)."""
        return self._base_json()

    @staticmethod
    def _base_kwargs(data: dict[str, Any]) -> dict[str, Any]:
        """The shared constructor kwargs from a stored frame dict (tolerates missing keys).

        Tolerates the pre-``kind`` field name ``delegate_tool_call_id`` for
        ``tool_call_id`` so an older plan_review frame still loads (开发期无兼容层，
        but the rename is free to honor)."""
        from agentcore.runtime.runs.serialize import transcript_from_json

        data = dict(data or {})
        return {
            "message_id": data.get("message_id", ""),
            "conversation_id": data.get("conversation_id", ""),
            "user_id": data.get("user_id", ""),
            "captain_run_id": data.get("captain_run_id", ""),
            "checkpoint_id": data.get("checkpoint_id", ""),
            "tool_call_id": (
                data.get("tool_call_id") or data.get("delegate_tool_call_id") or ""
            ),
            "base_system_prompt": data.get("base_system_prompt", "") or "",
            "user_message": data.get("user_message", "") or "",
            "transcript": transcript_from_json(data.get("transcript")),
            "journal": list(data.get("journal") or []),
            "trace_id": data.get("trace_id"),
        }


@dataclass(kw_only=True)
class PlanReviewSuspension(TurnSuspension):
    """A turn frozen at a ``plan_review`` checkpoint — the WaveScheduler resume substrate.

    Adds the ``plan`` (with its already-minted run_ids) + the ``completed`` seed map
    (the scheduler ``seed_completed``), so resume treats finished nodes as done and
    runs only the downstream tail; plus the reviewed ``steps`` + gated ``pending`` so
    the card re-renders on reopen.
    """

    kind: ClassVar[SuspensionKind] = SuspensionKind.PLAN_REVIEW

    plan: RunPlan
    # run_id → finished RunState (the WaveScheduler ``seed_completed`` for resume).
    completed: dict[str, RunState] = field(default_factory=dict)
    # The just-completed checkpoint nodes the user is reviewing ({run_id, role, summary})
    # and a peek at the gated downstream nodes ({run_id, role}) — re-emitted on resume.
    steps: list[dict[str, Any]] = field(default_factory=list)
    pending: list[dict[str, Any]] = field(default_factory=list)

    @property
    def checkpoint_run_ids(self) -> set[str]:
        """run_ids of the reviewed checkpoint nodes — the roots an ``adjust`` steer
        scopes to (its not-yet-run transitive dependents)."""
        return {s["run_id"] for s in self.steps if "run_id" in s}

    def to_json(self) -> dict[str, Any]:
        from agentcore.runtime.runs.serialize import plan_to_json, state_map_to_json

        data = self._base_json()
        data.update(
            plan=plan_to_json(self.plan),
            completed=state_map_to_json(self.completed),
            steps=list(self.steps),
            pending=list(self.pending),
        )
        return data


@dataclass(kw_only=True)
class AskUserSuspension(TurnSuspension):
    """A turn frozen at the CEO's ``ask_user`` checkpoint — the CEO-loop resume substrate.

    No plan tail: resume just maps the user's answer to the ``ask_user`` tool result
    and continues the CEO loop. Carries the card payload (``question`` / ``options`` /
    ``context`` / ``multiple``) so resume re-emits the prompt + validates the picks
    against the offered options.
    """

    kind: ClassVar[SuspensionKind] = SuspensionKind.ASK_USER

    question: str = ""
    options: list[str] = field(default_factory=list)
    context: str = ""
    multiple: bool = False

    def to_json(self) -> dict[str, Any]:
        data = self._base_json()
        data.update(
            question=self.question,
            options=list(self.options),
            context=self.context,
            multiple=self.multiple,
        )
        return data


def suspension_from_json(data: dict[str, Any]) -> TurnSuspension:
    """Rebuild the right :class:`TurnSuspension` subclass from a stored frame dict.

    Dispatches on the ``kind`` discriminator; an absent / unknown kind defaults to
    ``plan_review`` (the only kind that existed before the union, so a legacy frame
    still loads). Tolerates missing keys — every field falls back to a safe default.
    """
    from agentcore.runtime.runs.serialize import plan_from_json, state_map_from_json

    data = dict(data or {})
    base = TurnSuspension._base_kwargs(data)
    if data.get("kind") == SuspensionKind.ASK_USER.value:
        return AskUserSuspension(
            **base,
            question=data.get("question", "") or "",
            options=list(data.get("options") or []),
            context=data.get("context", "") or "",
            multiple=bool(data.get("multiple") or False),
        )
    return PlanReviewSuspension(
        **base,
        plan=plan_from_json(data.get("plan") or {}),
        completed=state_map_from_json(data.get("completed")),
        steps=list(data.get("steps") or []),
        pending=list(data.get("pending") or []),
    )


# Persistence closures threaded from the pipeline into the suspending faces (so the
# tools package stays free of a DB import). The saver persists a frame before the
# suspend wait; the deleter drops it after a live in-process resolve. Wired to
# ``runtime/suspension_persistence.py`` by the pipeline; ``None`` ⇒ 2a in-memory only.
SuspensionSaver = Callable[["TurnSuspension"], Awaitable[None]]
SuspensionDeleter = Callable[[str], Awaitable[None]]


def find_tool_call_id(transcript: list[LLMMessage], tool_name: str) -> str:
    """The id of the trailing ``tool_name`` tool_call in a captured CEO transcript.

    The pause happened inside that call, so the transcript ends with the assistant
    message that issued it; the resumed tool result must echo this id. Scans from the
    end for the last assistant message carrying a ``tool_name`` tool_call. Empty
    string when none is found (capture then degrades — the face skips it).
    """
    for msg in reversed(transcript):
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        for tc in msg.tool_calls:
            if tc.function.name == tool_name:
                return tc.id
    return ""
