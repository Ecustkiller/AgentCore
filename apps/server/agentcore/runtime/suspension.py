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
  result, then continues the CEO loop. Carries only the reviewed ``steps`` / gated
  ``pending`` (display re-render): the ``plan`` (with minted run_ids) and the
  finished-worker ``completed`` seed are BOTH re-projected from the journal on resume
  (``plan_from_journal`` / ``completed_from_journal``), not serialized — 执行级事件溯源 Phase 2.
- **ask_user** — the CEO paused mid-loop on its ``ask_user`` checkpoint (the one
  asking primitive — opening 引导 or mid-task fork). Resume maps the user's answer
  to the ``ask_user`` tool result and continues the CEO loop (no plan tail). Carries
  the card payload (message / context / assumptions / questions / style_options) so
  resume can re-emit it.

Every frame shares: the CEO ``transcript`` at the pause (system + history + user +
the assistant message carrying the suspended tool_call), the ``tool_call_id`` that
result must echo (so the rebuilt transcript stays a valid tool-call/result pair),
the ``base_system_prompt`` + ``user_message`` (to re-wire the CEO toolset), and the
``checkpoint_id`` (so resume re-emits the resolution).

The journal-so-far is NOT in the frame: it is the §8.3 ``turn_journal`` (唯一事实源),
written at pause and re-hydrated onto :attr:`TurnSuspension.journal` when the resume
claims the frame (see ``runtime/suspension_persistence.py``). The frame thus carries
only the resume *control* state, not a second copy of the replay stream.

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

from agentcore.runtime.checkpoints import AskCheckpointIntent

# NOTE: serialize helpers are imported lazily inside to_json / from_json so this
# module stays import-light (stdlib only at import time). The captain executor —
# itself imported during the ``runs`` package init — imports ``captain_transcript``
# from here, so a top-level ``runs.serialize`` import could risk an init-order cycle.

if TYPE_CHECKING:
    from agentcore.llm.provider.protocol import LLMMessage
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

# The turn's prior-turn history (the CEO window's history prefix), bound by the pipeline
# at turn start so a suspending face can capture it into the durable frame — the resume
# splices it back ahead of the journal-folded rounds (执行级事件溯源 Phase 2 ⑤; the journal
# stores only history's LENGTH). Symmetric with :data:`captain_transcript`: a contextvar
# because the faces run deep inside the captain loop with no handle on the history list.
# ``None`` outside a turn (tests / standalone) → the face captures no history.
turn_history: ContextVar[list[dict[str, Any]] | None] = ContextVar("turn_history", default=None)


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
    resume substrate and set :attr:`kind`. Everything but :attr:`journal` (which
    lives in ``turn_journal``) is JSON-round-trippable (:meth:`to_json` /
    :func:`suspension_from_json`) into the ``paused_turns.frame`` column.
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
    # The cloud project (= workspace folder) scope this turn ran in, captured so the resumed
    # CEO toolset re-wires consult_memory to the SAME project scope (project 主题 first, then
    # global) instead of degrading to global-only — Agent记忆与知识系统 §二. ``None`` for a
    # 裸聊 / local turn with no cloud folder. Serialized into the frame (resume control state).
    folder_id: str | None = None
    # The long-term-memory master switch at pause: captured so a resume re-wires the toolset
    # the SAME way the original turn did — memory OFF ⇒ consult_memory stays UNwired on resume
    # too (privacy off-ramp parity, Agent记忆与知识系统 §二). Defaults True (legacy frames + the
    # always-on default) so an absent value never silently strips memory from a resume.
    memory_enabled: bool = True
    # The CEO window at pause is a PROJECTION of the turn journal, NOT a stored blob
    # (执行级事件溯源 Phase 2 ⑤): resume folds ``journal_entries`` + ``history`` via
    # ``window_from_journal``. Kept as an in-memory carrier (the suspending face captures it
    # off ``captain_transcript`` for the conformance golden + a live re-pause-during-settle),
    # but NO LONGER serialized into the frame — so it defaults empty on a claimed frame.
    transcript: list[LLMMessage] = field(default_factory=list)
    # The prior-turn context the resumed CEO window splices in (its history prefix). The
    # journal stores only its LENGTH (history is itself a projection of earlier turns), so
    # resume re-supplies it: the cloud reloads from the message DB, the Sidecar (no DB)
    # persists it in its local frame record (set here from the ``turn_history`` contextvar at
    # capture). NOT serialized into the cloud ``paused_turns.frame``.
    history: list[dict[str, Any]] = field(default_factory=list)
    # The team-graph journal up to and including the pause's ``*_required`` event. A
    # transient in-memory carrier ONLY: it is persisted to the ``turn_journal`` table
    # (唯一事实源, §8.3) — NOT into ``paused_turns.frame`` — and re-hydrated here when
    # the resume claims the frame, so the resumed turn replays the whole graph.
    journal: list[dict[str, Any]] = field(default_factory=list)
    # The same pause point as the §8.3 fact-log stream: the turn's single ordered log
    # (execution facts — turn_started / round_boundary / llm_call — interleaved with the
    # forwarded display facts) up to and including the suspending ``*_required`` event.
    # Like :attr:`journal` a transient carrier ONLY (NOT serialized into the frame): the
    # suspending face captures it from the ambient ``current_fact_log`` so the pause
    # persists the EXECUTION-level stream (``window_from_journal``-rebuildable), and
    # :func:`claim_paused_turn` re-hydrates it. Supersedes :attr:`journal` as the persist
    # source when present; the display ``journal`` remains the degraded fallback (no log
    # bound) and the resume seed (re-derived from the loaded stream on claim).
    journal_entries: list[dict[str, Any]] = field(default_factory=list)
    # Set when the best-effort ``turn_journal`` mirror failed at pause time. Resume
    # checks this to surface a clear error instead of silently rebuilding an empty CEO
    # window (the frame alone is not enough without the journal facts).
    journal_degraded: bool = False
    trace_id: str | None = None

    def _base_json(self) -> dict[str, Any]:
        """The shared fields (incl. the ``kind`` discriminator) for ``paused_turns.frame``."""
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
            "folder_id": self.folder_id,
            "memory_enabled": self.memory_enabled,
            # NOTE: ``transcript`` / ``history`` / ``journal`` / ``journal_entries`` are
            # deliberately NOT serialized into the frame (执行级事件溯源 Phase 2 ⑤): the CEO
            # window is rebuilt by ``window_from_journal`` from the turn_journal facts (§8.3)
            # + reloaded history, so the frame holds only resume CONTROL metadata. See the
            # module docstring + ``runtime/journal.py``.
            "journal_degraded": self.journal_degraded,
            "trace_id": self.trace_id,
        }

    def to_json(self) -> dict[str, Any]:
        """Flatten to the JSON dict stored in ``paused_turns.frame`` (subclasses extend)."""
        return self._base_json()

    @staticmethod
    def _base_kwargs(data: dict[str, Any]) -> dict[str, Any]:
        """The shared constructor kwargs from a stored frame dict (tolerates missing keys)."""
        data = dict(data or {})
        return {
            "message_id": data.get("message_id", ""),
            "conversation_id": data.get("conversation_id", ""),
            "user_id": data.get("user_id", ""),
            "captain_run_id": data.get("captain_run_id", ""),
            "checkpoint_id": data.get("checkpoint_id", ""),
            "tool_call_id": data.get("tool_call_id") or "",
            "base_system_prompt": data.get("base_system_prompt", "") or "",
            "user_message": data.get("user_message", "") or "",
            "folder_id": data.get("folder_id"),
            # Legacy frames (pre-field) lack the key → default True so a resume never silently
            # strips memory that the original turn had on.
            "memory_enabled": data.get("memory_enabled", True),
            # NOTE: ``transcript`` / ``history`` / ``journal`` / ``journal_entries`` are NOT
            # in the frame (Phase 2 ⑤) — the CEO window is rebuilt from the turn_journal facts
            # on claim (``window_from_journal``), so they default empty here. The Sidecar's
            # local record carries journal_entries + history separately (it has no DB).
            "journal_degraded": bool(data.get("journal_degraded")),
            "trace_id": data.get("trace_id"),
        }


@dataclass(kw_only=True)
class PlanReviewSuspension(TurnSuspension):
    """A turn frozen at a ``plan_review`` checkpoint — the WaveScheduler resume substrate.

    The ``plan`` (with its already-minted run_ids) and the finished-node ``completed`` seed
    are BOTH rebuilt from the journal on resume (``plan_from_journal`` / ``completed_from_journal``
    — NOT serialized blobs, 执行级事件溯源 Phase 2), so the resumed drive re-mints nothing and
    runs only the downstream tail; only the reviewed ``steps`` + gated ``pending`` (the card's
    display re-render on reopen) ride in the frame.
    """

    kind: ClassVar[SuspensionKind] = SuspensionKind.PLAN_REVIEW

    # The delegate's DAG (with minted run_ids). An in-memory carrier ONLY (执行级事件溯源
    # Phase 2, frame.plan 退场): NOT serialized — resume rebuilds it from the journal's
    # ``plan_snapshot`` fact (``plan_from_journal``); the delegate captures it here live for
    # the conformance golden. An empty RunPlan placeholder on a claimed frame.
    plan: RunPlan
    # run_id → finished RunState (the WaveScheduler ``seed_completed`` for resume). An
    # in-memory carrier ONLY (执行级事件溯源 Phase 2 ⑥): NOT serialized into the frame — resume
    # re-seeds it from the journal's run-final facts (``completed_from_journal``), the
    # delegate still captures it here live for the conformance golden. Empty on a claim.
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
        data = self._base_json()
        # NOTE: NEITHER ``plan`` NOR ``completed`` is serialized (执行级事件溯源 Phase 2): the
        # delegate journals a ``plan_snapshot`` fact + a run-final fact per worker, so resume
        # rebuilds both from the journal (``plan_from_journal`` / ``completed_from_journal``,
        # gated by the conformance golden). Both stay in-memory carriers (the delegate captures
        # them live for that golden) but off the frame — only the reviewed ``steps`` / gated
        # ``pending`` (display re-render on reopen) ride along.
        data.update(
            steps=list(self.steps),
            pending=list(self.pending),
        )
        return data


@dataclass(kw_only=True)
class AskUserSuspension(TurnSuspension):
    """A turn frozen at the CEO's ``ask_user`` checkpoint — the CEO-loop resume substrate.

    No plan tail: resume just maps the user's answer to the ``ask_user`` tool result
    and continues the CEO loop. Carries the unified card payload so resume re-emits the
    full prompt: ``question`` (the framing / opening line — the tool's ``message``),
    ``context`` background, plus the rich opening content ``assumptions`` (起步计划
    chips), ``questions`` (the askable items, each with kind/options/multiple/default)
    and ``style_options`` (visual presets). All but ``question`` are empty for a compact
    mid-task fork.
    """

    kind: ClassVar[SuspensionKind] = SuspensionKind.ASK_USER

    question: str = ""
    context: str = ""
    assumptions: list[dict[str, Any]] = field(default_factory=list)
    questions: list[dict[str, Any]] = field(default_factory=list)
    style_options: list[dict[str, Any]] = field(default_factory=list)
    intent: AskCheckpointIntent = "decision"

    def to_json(self) -> dict[str, Any]:
        data = self._base_json()
        data.update(
            question=self.question,
            context=self.context,
            assumptions=list(self.assumptions),
            questions=list(self.questions),
            style_options=list(self.style_options),
            intent=self.intent,
        )
        return data


def suspension_from_json(data: dict[str, Any]) -> TurnSuspension:
    """Rebuild the right :class:`TurnSuspension` subclass from a stored frame dict."""
    from agentcore.runtime.runs.serialize import plan_from_json

    data = dict(data or {})
    kind_raw = data.get("kind")
    if kind_raw not in {SuspensionKind.PLAN_REVIEW.value, SuspensionKind.ASK_USER.value}:
        raise ValueError(f"missing or unknown suspension kind: {kind_raw!r}")
    base = TurnSuspension._base_kwargs(data)
    if kind_raw == SuspensionKind.ASK_USER.value:
        return AskUserSuspension(
            **base,
            question=data.get("question", "") or "",
            context=data.get("context", "") or "",
            assumptions=list(data.get("assumptions") or []),
            questions=list(data.get("questions") or []),
            style_options=list(data.get("style_options") or []),
            intent=data.get("intent") or "decision",
        )
    # NOTE: NEITHER ``plan`` NOR ``completed`` is read from the frame (执行级事件溯源 Phase 2) —
    # both default empty and are re-projected from the journal on resume (``plan_from_journal``
    # / ``completed_from_journal``). ``plan_from_json({})`` yields an empty RunPlan placeholder
    # (the field is required); the resume fold replaces it with the journaled DAG.
    return PlanReviewSuspension(
        **base,
        plan=plan_from_json({}),
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
