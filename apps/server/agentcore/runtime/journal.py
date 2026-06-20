"""Turn Journal — persist a turn's execution fact stream and project it back.

The §18.3 Turn Journal is the唯一事实源 for a turn's execution: an append-only,
per-turn ordered stream of facts (run/tool/interaction events for a multi-agent
turn; reasoning/tool 步 for a single-agent turn; a closing ``turn_end``). It lives
in the ``turn_journal`` table (keyed by ``turn_id`` == the assistant ``message_id``)
and REPLACES the old ``messages.runs`` JSON blob.

「一切皆投影」(§18.3): nothing else stores the replay payload. The assistant
message's ``MessageDetail.runs`` is rebuilt from the journal on read via
:func:`runs_from_entries`; the write side flattens the in-memory sink payload to
journal entries via :func:`entries_from_runs`. The two are exact inverses, so a
turn round-trips through the journal unchanged.

This module owns the (pure) projection transforms + a best-effort persist helper.
Storage is the :class:`~agentcore.db.repositories.TurnJournalRepository` (the
§18.6 ``Journal`` port's Postgres implementation); a future Sidecar swaps it for a
local one without touching the engine.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.runtime.events import _JOURNAL_SURFACE_TYPES, EventType
from agentcore.runtime.facts import EXECUTION_ONLY_KINDS, FactKind
from agentcore.runtime.runs.types import RunKind

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from agentcore.llm.protocol import LLMMessage
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunState

logger = get_logger(__name__)

# Journal kind for the per-turn outcome fact (finish_reason). The run/tool/
# interaction facts keep their SSE event type as their kind; single-agent process
# steps are prefixed so the two lanes are distinguishable in the table.
KIND_TURN_END = "turn_end"
_PROCESS_PREFIX = "process_"


def entries_from_runs(runs: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Flatten an in-memory ``runs`` replay payload into ordered journal entries.

    ``runs`` is the sink-built ``{events, finish_reason, process?}`` payload (see
    ``runtime/pipeline._build_runs_payload``). Each entry is ``{kind, payload, ts}``
    in emission order: the team-graph ``events`` first (each keeping its SSE event
    type as ``kind`` + original ``timestamp`` as ``ts``), then any single-agent
    ``process`` steps (kind-prefixed), then a closing ``turn_end`` carrying the
    finish reason. Returns ``[]`` for an empty / absent payload.
    """
    if not runs:
        return []
    entries: list[dict[str, Any]] = []
    for ev in runs.get("events") or []:
        entries.append(
            {
                "kind": ev.get("type") or "",
                "payload": ev.get("payload") or {},
                "ts": ev.get("timestamp"),
            }
        )
    for step in runs.get("process") or []:
        entries.append(
            {
                "kind": f"{_PROCESS_PREFIX}{step.get('kind') or 'step'}",
                "payload": step,
                "ts": None,
            }
        )
    # turn_end (the per-turn outcome fact): finish_reason + an optional error. A 报错回合
    # carries its error here so the inline error card replays on reload (Tier 2 a) — the
    # live error rides a transport-only ``error`` SSE event (never journaled), so this
    # outcome fact is its only durable home. Emitted when EITHER is present.
    finish_reason = runs.get("finish_reason")
    run_error = runs.get("error")
    if finish_reason is not None or run_error is not None:
        payload: dict[str, Any] = {"finish_reason": finish_reason}
        if run_error is not None:
            payload["error"] = run_error
        entries.append({"kind": KIND_TURN_END, "payload": payload, "ts": None})
    return entries


# A run node's terminal display event: the deltas-退场 synthesis splices the run's full
# output/thinking right before it. Both COMPLETED and FAILED qualify — a failed worker
# can still have produced (partial) output worth showing on reload.
_RUN_TERMINAL_TYPES = frozenset(
    {EventType.RUN_COMPLETED.value, EventType.RUN_FAILED.value}
)


def _splice_synthetic_deltas(
    events: list[dict[str, Any]],
    final_outputs: dict[str, dict[str, str]],
    agent_run_ids: dict[str, str],
) -> list[dict[str, Any]]:
    """Reconstruct each agent run's run_output_delta / run_reasoning_delta from its
    ``message_final`` fact (执行级事件溯源: deltas 退场).

    The per-token worker deltas are no longer journaled; instead a single equivalent
    delta block is spliced in just before the run's terminal event (run_completed /
    run_failed), so the unchanged client fold rebuilds the node's 输出 / 思考全文 on
    reload (it sees the same event types, merely coalesced into one delta each).

    Scoped to agent runs (``agent_run_ids``, from the kind=agent run_started): the
    CAPTAIN's own ``message_final`` is the chat bubble's text (streamed as the
    turn-level ``content_delta``, not run-scoped), so it must NOT light up the captain
    run node — and its run_id is absent from ``agent_run_ids``, so it is skipped here.
    Reasoning precedes content, mirroring the live order (DeepSeek streams the whole
    reasoning_content before any content); both inherit the terminal event's timestamp
    so the replay timeline orders them immediately before completion.
    """
    out: list[dict[str, Any]] = []
    for ev in events:
        if ev.get("type") in _RUN_TERMINAL_TYPES:
            run_id = (ev.get("payload") or {}).get("run_id")
            agent_id = agent_run_ids.get(run_id) if run_id else None
            final = final_outputs.get(run_id) if run_id else None
            if final is not None and agent_id is not None:
                ts = ev.get("timestamp")
                if final["reasoning"]:
                    out.append(
                        {
                            "type": EventType.RUN_REASONING_DELTA.value,
                            "payload": {
                                "run_id": run_id,
                                "agent_id": agent_id,
                                "delta": final["reasoning"],
                            },
                            "timestamp": ts,
                        }
                    )
                if final["content"]:
                    out.append(
                        {
                            "type": EventType.RUN_OUTPUT_DELTA.value,
                            "payload": {
                                "run_id": run_id,
                                "agent_id": agent_id,
                                "delta": final["content"],
                            },
                            "timestamp": ts,
                        }
                    )
        out.append(ev)
    return out


def runs_from_entries(entries: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Project ordered journal entries back into a ``runs`` replay payload (DISPLAY).

    Inverse of :func:`entries_from_runs` for the team-graph ``events`` / single-agent
    ``process`` / ``turn_end`` lanes: events rebuild the ``{type, payload, timestamp}``
    shape the client folds, process steps restore verbatim, ``turn_end`` supplies
    ``finish_reason``. Returns ``None`` when nothing is replayable, matching the
    old「``messages.runs`` is NULL」contract so the client renders a plain bubble.

    Two journal lineages flow through here and must project IDENTICALLY (so a turn's
    bubble is the same whoever wrote its journal):

    - **Legacy / seeded / resume-frame journals** (no §18.3 execution facts): the
      events were ALREADY display-gated at write (``_build_runs_payload`` stored the
      team graph only when surfaced, ``[]`` otherwise; a salvaged turn stored
      ``{events:[], finish}`` on purpose). So these project as a PURE inverse —
      untouched — preserving the round-trip contract + the cancelled-salvage bubble +
      ``suspension_persistence`` resume hydration.
    - **Execution-sourced journals** (carry execution facts — the fact log is the
      single source, 执行级事件溯源 §18.3): these stored the FULL UNGATED stream
      (the captain's own ``run_*`` / ``tool_use_*`` ride it too). Re-apply the display
      gate so a non-surfaced turn does not suddenly render the captain's run events as
      a team graph: drop ``events`` unless a surface type is present (parity with
      ``EventSink.execution_journal``), and project to ``None`` when nothing is left to
      show (a plain chat turn — its facts persist for window rebuild but display as a
      plain bubble). The discriminator is the presence of execution facts, NOT the
      content, so the two clauses never fire on a legacy/salvage journal.

    deltas 退场: an execution-sourced journal no longer carries per-token
    ``run_output_delta`` / ``run_reasoning_delta`` (they are transport-only liveliness
    now). Each agent run's full output + thinking is its ``message_final`` fact, from
    which :func:`_splice_synthetic_deltas` reconstructs ONE equivalent delta block per
    run, spliced just before the run's terminal event — so the client fold replays the
    same 输出 / 思考 with zero change. (A legacy journal that still carries real deltas
    has no ``message_final`` facts, so the synthesis is a no-op and it round-trips
    untouched.)
    """
    if not entries:
        return None
    events: list[dict[str, Any]] = []
    process: list[dict[str, Any]] = []
    finish_reason: str | None = None
    # The 报错回合 outcome (code + message) carried on turn_end, projected back so the
    # bubble rebuilds its inline error card on reload (Tier 2 a). None for a clean turn.
    turn_error: dict[str, Any] | None = None
    has_exec_facts = False
    # 上下文传递可视化 通道①: the CEO captain's received context is TURN-LEVEL (the chat
    # bubble above the graph), so it is lifted out of the node events into captain_context
    # — present even on a pure-chat turn (no surface), where the events gate to []. Keyed
    # by the captain run id (run_started kind=captain).
    captain_run_id: str | None = None
    captain_context: list[dict[str, Any]] | None = None
    # deltas 退场: a worker/revision run's full output + thinking now lives only in its
    # ``message_final`` fact (the per-token run_output_delta / run_reasoning_delta are no
    # longer journaled). Collect those finals (run_id → {content, reasoning}) and the
    # agent-kind run ids (run_id → agent_id, from run_started) so the display projection
    # can synthesize equivalent delta blocks below — keeping the client fold unchanged.
    final_outputs: dict[str, dict[str, str]] = {}
    agent_run_ids: dict[str, str] = {}
    for entry in entries:
        kind = entry.get("kind") or ""
        payload = entry.get("payload") or {}
        if kind == KIND_TURN_END:
            finish_reason = payload.get("finish_reason")
            turn_error = payload.get("error")
        elif kind == FactKind.MESSAGE_FINAL.value:
            # An execution fact (skipped from events like its peers), BUT its full
            # text is replayed as a synthetic delta block (spliced below). Collect
            # it keyed by run_id; the captain's own message_final is collected too but
            # is never synthesized (its run_id is not an agent run — see the splice).
            has_exec_facts = True
            run_id = payload.get("run_id")
            if run_id:
                final_outputs[run_id] = {
                    "content": payload.get("content") or "",
                    "reasoning": payload.get("reasoning") or "",
                }
            continue
        elif kind in EXECUTION_ONLY_KINDS:
            # Execution-level facts (§18.3: turn_started / round_boundary / llm_call /
            # note / tool_call / plan_snapshot) carry engine-rebuild state, not client-
            # foldable display events — skip them so they never leak into runs.events
            # (the client fold would choke on an unknown event type). Their presence
            # marks this as an execution-sourced journal → re-gate the display below.
            has_exec_facts = True
            continue
        elif kind.startswith(_PROCESS_PREFIX):
            process.append(payload)
        else:
            # Remember each agent (worker / revision) run's agent_id so the synthetic
            # delta block can be attributed (the captain run_started is kind=captain →
            # excluded, so its message_final never becomes a run-node delta). The captain
            # run id is remembered too, so its run_context lifts to captain_context below.
            if kind == EventType.RUN_STARTED.value:
                run_kind = payload.get("kind")
                if run_kind == RunKind.AGENT.value:
                    run_id = payload.get("run_id")
                    if run_id:
                        agent_run_ids[run_id] = payload.get("agent_id") or ""
                elif run_kind == RunKind.CAPTAIN.value:
                    captain_run_id = payload.get("run_id")
            elif (
                kind == EventType.RUN_CONTEXT.value
                and captain_run_id is not None
                and payload.get("run_id") == captain_run_id
            ):
                # 上下文传递可视化 通道①+⑤: capture the captain's context turn-level, GROWING
                # it across every emit (opening + each post-delegation team readback) — the
                # same APPEND the live/replay folds do. Still appended to events below (kept
                # for the team-graph round-trip); the client routes it off the captain node
                # and reads it from captain_context instead.
                if captain_context is None:
                    captain_context = []
                captain_context.extend(payload.get("blocks") or [])
            events.append(
                {"type": kind, "payload": payload, "timestamp": entry.get("ts")}
            )
    if final_outputs:
        events = _splice_synthetic_deltas(events, final_outputs, agent_run_ids)
    if has_exec_facts:
        # Surface gate (parity with EventSink.execution_journal): the captain's own
        # run events are execution detail, not a replayable team graph — show events
        # only when the turn surfaced (delegated / checkpointed).
        if not any(e["type"] in _JOURNAL_SURFACE_TYPES for e in events):
            events = []
        # None-gate: an execution-sourced turn with no graph + no process is a plain
        # chat turn → render a plain bubble (the facts still persist for rebuild). A
        # captain_context keeps it non-None: a pure-chat turn still has「收到的上下文」to
        # replay on the CEO bubble (上下文传递可视化 通道①), even with no graph/process.
        # A turn_error keeps it non-None too: a 报错回合 (e.g. the captain failed after
        # workers ran) must still replay its error card on reload (Tier 2 a).
        if not events and not process and not captain_context and not turn_error:
            return None
    runs: dict[str, Any] = {"events": events, "finish_reason": finish_reason}
    if process:
        runs["process"] = process
    if captain_context is not None:
        runs["captain_context"] = captain_context
    if turn_error is not None:
        runs["error"] = turn_error
    return runs


def system_prompt_from_journal(entries: list[dict[str, Any]] | None) -> str | None:
    """The verbatim CEO system prompt this turn ran with (本回合提示词, 提示词透明 L3).

    Reads the ``turn_started`` head fact's ``system_prompt`` — captured verbatim at turn
    start because it is dynamic (date / 能力目录 / attachments), so re-rendering it would
    drift (facts §18.3). Returns ``None`` when there is no head fact to read (a legacy /
    display-only journal, a user message, or a turn whose best-effort journal write was
    lost) so the caller can 404. The prompt is an execution fact (``EXECUTION_ONLY_KINDS``)
    deliberately kept out of the display ``runs`` projection; this is the one read path
    that surfaces it — to the turn's owner.
    """
    if not entries:
        return None
    for entry in entries:
        if (entry.get("kind") or "") == FactKind.TURN_STARTED.value:
            return (entry.get("payload") or {}).get("system_prompt")
    return None


def window_from_journal(
    entries: list[dict[str, Any]] | None,
    *,
    run_id: str | None = None,
    history: list[LLMMessage] | None = None,
) -> list[LLMMessage] | None:
    """Project a turn's journal facts into ONE run's LLM window (EXECUTION).

    The execution-side counterpart of :func:`runs_from_entries`: where that rebuilds
    the *display* runs payload, this folds the §18.3 execution facts back into the
    ``list[LLMMessage]`` the engine actually fed the model — the same shape the live
    captain transcript / a worker's ``messages`` take, so resume can feed it straight
    back and the conformance golden can assert it ``==`` the transcript at a pause
    (执行级事件溯源 §18.3, the ``window_from_journal`` projection).

    Correct-by-construction — only outputs are journaled, so the window is the fold of
    all prior facts (no quadratic input duplication):

    - ``turn_started`` → the head: a ``system`` message (the verbatim captured prompt)
      + the ``user`` message, with ``history`` (prior turns — supplied by the caller,
      since the facts carry only its length: history is itself a projection of earlier
      turns) spliced between them exactly as the executor builds it.
    - each ``llm_call`` of the target run that carried ``tool_calls`` → the ``assistant``
      message (``content`` / ``reasoning_content`` echoed verbatim — DeepSeek thinking
      mode 400s without the reasoning on a tool-call turn, llm.mdc §4.3 — plus the
      ``tool_calls``), followed by one ``tool`` message per **completed** call (result
      matched by ``tool_call_id`` from the execution ``tool_call`` fact — the FULL
      post-annotation text the round carried, 边界① cleared). A call with no ``tool_call``
      fact is the SUSPENDED one (the pause happens inside ``ask_user`` / ``delegate``,
      which blocks before the fact is recorded): no tool message, so the window ends at
      the assistant exactly as the paused transcript does. A no-tool ``llm_call`` is the
      turn's final answer — the loop *returns* it, never appends it.
    - each engine-injected ``note`` (NUDGE / FINALIZE / circuit-breaker / reflection)
      belonging to the target run (by the note's own ``run_id``, 边界② cleared) → a
      ``user`` message, exactly as the loop injects it — so a captain note injected
      mid-delegate still folds into the captain window.

    ``run_id`` scopes a multi-agent turn to one run; ``None`` infers the captain (the
    run of the first ``role="captain"`` round_boundary — the resume target, whose head
    is ``turn_started``). Returns ``None`` when there is no ``turn_started`` to anchor
    the head (a legacy / display-only journal): only the captain window is reconstructed,
    whose head is a fact; a worker's task-prompt head is not yet journaled.
    """
    if not entries:
        return None
    from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction

    # Head anchor + (when unscoped) the captain run to fold: one pass for both.
    started: dict[str, Any] | None = None
    target = run_id
    for entry in entries:
        kind = entry.get("kind") or ""
        payload = entry.get("payload") or {}
        if kind == FactKind.TURN_STARTED.value and started is None:
            started = payload
        elif (
            kind == FactKind.ROUND_BOUNDARY.value
            and target is None
            and payload.get("role") == "captain"
        ):
            target = payload.get("run_id") or ""
    if started is None:
        return None
    if target is None:
        # No captain round_boundary (degenerate / single-run) → fold the first run.
        for entry in entries:
            if (entry.get("kind") or "") == FactKind.ROUND_BOUNDARY.value:
                target = (entry.get("payload") or {}).get("run_id") or ""
                break

    # Index each tool result by tool_call_id from the execution ``tool_call`` fact (the
    # FULL post-annotation result the round actually carried — NOT the forwarded display
    # ``tool_use_end``, whose text predates the CEO citation fold, 边界① cleared). The
    # assistant→tool pairing matches on tool_call_id (globally unique), so a worker's
    # tools never bleed into the captain window.
    tool_results: dict[str, str] = {}
    for entry in entries:
        if (entry.get("kind") or "") == FactKind.TOOL_CALL.value:
            payload = entry.get("payload") or {}
            tcid = payload.get("tool_call_id")
            if tcid:
                tool_results[tcid] = payload.get("result") or ""

    # Head: system + history (caller-supplied prior turns) + user — the executor's
    # exact build (runs/executor.build_captain_executor).
    window: list[LLMMessage] = [
        LLMMessage(role="system", content=started.get("system_prompt") or "")
    ]
    if history:
        window.extend(history)
    window.append(LLMMessage(role="user", content=started.get("user_message") or ""))

    # Fold the target run's rounds in stream order: assistant (+ its tool results),
    # then any active-run note, mirroring how react_loop mutates ``messages``.
    active_run: str | None = None
    for entry in entries:
        kind = entry.get("kind") or ""
        payload = entry.get("payload") or {}
        if kind == FactKind.ROUND_BOUNDARY.value:
            active_run = payload.get("run_id") or ""
        elif kind == FactKind.LLM_CALL.value:
            if payload.get("run_id") != target:
                continue
            tool_calls = payload.get("tool_calls") or []
            if not tool_calls:
                # A no-tool round is the turn's final answer (the loop returns it),
                # not part of the window the next round would have seen.
                continue
            window.append(
                LLMMessage(
                    role="assistant",
                    content=payload.get("content") or None,
                    tool_calls=[
                        ToolCall(
                            id=tc.get("id") or "",
                            type=tc.get("type") or "function",
                            function=ToolCallFunction(
                                name=(tc.get("function") or {}).get("name") or "",
                                arguments=(tc.get("function") or {}).get("arguments")
                                or "",
                            ),
                        )
                        for tc in tool_calls
                    ],
                    reasoning_content=payload.get("reasoning_content") or None,
                )
            )
            for tc in tool_calls:
                tcid = tc.get("id") or ""
                # Append a tool message ONLY when the call actually completed (a
                # ``tool_use_end`` fact exists). The pause itself happens INSIDE the
                # suspended call (``ask_user`` / ``delegate``): it emitted ``tool_use_
                # start`` but no ``tool_use_end``, and the live transcript ends at the
                # assistant message with the result still pending (resume appends it).
                # So a missing result means "suspended / in-flight", NOT "empty result"
                # — keying on presence keeps the window == the paused transcript.
                if tcid in tool_results:
                    window.append(
                        LLMMessage(
                            role="tool",
                            content=tool_results[tcid],
                            tool_call_id=tcid,
                        )
                    )
        elif kind == FactKind.NOTE.value:
            # Attribute by the note's OWN run_id (边界② cleared), so a captain note
            # injected while a delegated worker is the active run still folds into the
            # captain window. Fall back to the active run for a note that carries no
            # run_id (a degenerate / pre-Phase-2 stream).
            note_run = payload.get("run_id") or active_run
            if note_run == target:
                window.append(
                    LLMMessage(
                        role=payload.get("role") or "user",
                        content=payload.get("content") or "",
                    )
                )
    return window


def completed_from_journal(
    entries: list[dict[str, Any]] | None,
) -> dict[str, RunState]:
    """Project the journal's worker run-final facts into the scheduler seed map (resume).

    The execution counterpart of ``frame.completed`` (执行级事件溯源 Phase 2 ⑥): every
    terminal worker recorded a ``message_final`` fact whose payload IS its seed
    :class:`RunState` (``serialize.run_final_fact`` → ``state_to_json``, tagged by the
    ``phase`` key). Fold them back keyed by ``run_id`` — with the SAME deserializer
    (``state_from_json``), so the projection is byte-for-byte the blob the frame stored
    (the conformance golden gates this ``==``) — so a resume re-seeds finished nodes from
    facts and bills the whole plan once, no旁路 frame.

    Last write per ``run_id`` wins (a retried / revised run supersedes). The captain's own
    ``message_final`` (content/reasoning, no ``phase``) is NOT a seed and is skipped, as is
    a legacy / display journal with no run-final facts (→ ``{}``).
    """
    if not entries:
        return {}
    from agentcore.runtime.runs.serialize import state_from_json

    completed: dict[str, RunState] = {}
    for entry in entries:
        if (entry.get("kind") or "") != FactKind.MESSAGE_FINAL.value:
            continue
        payload = entry.get("payload") or {}
        run_id = payload.get("run_id")
        # ``phase`` presence is the RunState-head discriminator: a worker run-final carries
        # the full seed shape, the captain's plain message_final does not.
        if run_id and "phase" in payload:
            completed[run_id] = state_from_json(payload)
    return completed


def plan_from_journal(entries: list[dict[str, Any]] | None) -> RunPlan | None:
    """Project the journal's ``plan_snapshot`` facts into the delegate's DAG (resume).

    The execution counterpart of ``frame.plan`` (执行级事件溯源 Phase 2, its exit): the
    delegate recorded a ``plan_snapshot`` fact (``serialize.plan_snapshot_fact`` →
    ``plan_to_json``) at plan build and after each ``adjust`` steer. Fold back the LAST one
    — last-write-wins, so the accumulated steer + any post-build mutation is reflected —
    with the SAME deserializer (``plan_from_json``), so the projection is byte-for-byte the
    graph the frame stored (the conformance golden gates this ``==``). A resume thus rebuilds
    the EXACT plan (its already-minted run_ids matching the ``completed_from_journal`` seed)
    and re-drives the unfinished tail, no旁路 frame.

    Returns ``None`` when no ``plan_snapshot`` fact is present (a legacy / display journal,
    or a non-delegate turn) — the caller falls back to the in-memory carrier.
    """
    if not entries:
        return None
    from agentcore.runtime.runs.serialize import plan_from_json

    latest: dict[str, Any] | None = None
    for entry in entries:
        if (entry.get("kind") or "") == FactKind.PLAN_SNAPSHOT.value:
            latest = entry.get("payload") or {}
    return plan_from_json(latest) if latest is not None else None


async def persist_turn_journal(
    session: AsyncSession,
    *,
    message_id: str | None,
    conversation_id: str,
    trace_id: str | None,
    runs: dict[str, Any] | None,
    entries: list[dict[str, Any]] | None = None,
) -> None:
    """Record a turn's replay payload to the journal (唯一事实源), best-effort.

    Called from the message-persistence tail right after the assistant row is
    written, on the SAME session, keyed by the assistant ``message_id``. Replaces
    the turn's rows wholesale (so a resume reusing the id re-persists cleanly). A
    failure must NEVER break the turn (文档铁律, same posture as the cost ledger): it
    rolls back only this write and logs — the reply is already committed and the
    worst case is a turn that won't replay its graph.

    ``entries`` is the pre-composed §18.3 fact-log stream (the single ordered log:
    the engine's execution facts interleaved with the forwarded display facts, plus
    the process timeline + ``turn_end`` tail). When given it is stored verbatim — the
    fact log is now the source. ``runs`` is the legacy display payload, flattened via
    :func:`entries_from_runs` when no fact log is supplied (the manual salvage / local
    relay / resume call sites that do not run the fact-recording pipeline).
    """
    entries = entries if entries is not None else entries_from_runs(runs)
    if not message_id or not entries:
        return
    from agentcore.db.repositories import TurnJournalRepository

    try:
        await TurnJournalRepository(session).record(
            turn_id=message_id,
            conversation_id=conversation_id,
            trace_id=trace_id,
            entries=entries,
        )
    except Exception as e:  # noqa: BLE001 — journal persistence must never break the turn
        await session.rollback()
        logger.warning(
            "journal.persist_failed",
            message_id=message_id,
            error=str(e),
        )

    # D2 观测：把同一份耐久 entries 投影成执行 span 树并导出（off the user path、
    # best-effort）。这里是所有回合路径（首轮 / 重答 / handoff / resume / salvage）写
    # 耐久 journal 的唯一汇点，故 span 树天然覆盖全路径。导出自身吞异常、绝不影响回合。
    if settings.observability_span_export_enabled:
        from agentcore.runtime.spans import export_turn_spans

        export_turn_spans(
            entries,
            trace_id=trace_id,
            conversation_id=conversation_id,
            turn_id=message_id,
        )
