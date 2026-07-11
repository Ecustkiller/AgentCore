"""Split from executor.py — see executor.py module docstring."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import asdict, replace
from typing import Any

from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import default_turn_profiles as default_profile_set
from agentcore.llm.provider.protocol import LLMMessage, LLMProvider, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    escalation_raised,
    escalation_required,
    escalation_resolved,
    run_cancelled,
    run_completed,
    run_context,
    run_failed,
    run_intake,
    run_started,
    team_note_posted,
)
from agentcore.runtime.facts import record_turn_fact
from agentcore.runtime.interaction import InteractionKind
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.runtime.routing import assess_intake
from agentcore.runtime.routing.intake import resolve_worker_token_ceiling
from agentcore.runtime.runs.constants import (
    AMEND_NOTE_TOOL_NAME,
    DEFAULT_CONTRACT_RETRIES,
    ESCALATE_TOOL_NAME,
    MAX_CONTRACT_RETRIES,
    MAX_DELEGATION_DEPTH,
    POST_NOTE_TOOL_NAME,
    READ_NOTES_TOOL_NAME,
)
from agentcore.runtime.runs.contract import ContractVerdict, check_contract, format_feedback
from agentcore.runtime.runs.executor_context import (
    _ancestors_by_id,
    _build_messages,
    _context_block_payloads,
    _safe_index_files,
)
from agentcore.runtime.runs.executor_identities import (
    _WORKER_CAPTAIN_IDENTITY,
    _WORKER_IDENTITY,
    _WORKER_TEAM_NOTE_POLICY,
    ESCALATION_CONCURRENCY_CAP,
    DelegateFactory,
    LeadSubteam,
)
from agentcore.runtime.runs.executor_shared import (
    _is_hard_failure,
    _priced_failure,
    _react_and_capture,
    _registry_with,
    _registry_without,
    _retry_message,
)
from agentcore.runtime.runs.notewall import NOTE_NUDGE_TEXT, NoteWall, format_notes_for_injection
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.salvage import cancelled_state_from_salvage, try_salvage_session
from agentcore.runtime.runs.serialize import (
    debrief_from_transcript,
    escalations_from_transcript,
    files_touched_from_transcript,
    run_final_fact,
)
from agentcore.runtime.runs.types import ContextBlock, RunPhase, RunSpec, RunState
from agentcore.tools.protocol import EscalationChannel, EscalationOutcome, ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.write_claims import WriteCoordinator

logger = get_logger(__name__)


def build_agent_executor(
    *,
    plan: RunPlan,
    llm: LLMProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    profile_set: ProfileSet | None = None,
    system_prompt: str,
    user_message: str,
    execution_id: str,
    approval_gate: ApprovalGate | None = None,
    delegate_factory: DelegateFactory | None = None,
    interaction_bridge: ClientRequestBridge | None = None,
    escalation_timeout: float | None = None,
    escalation_armed: bool = False,
    note_wall: NoteWall | None = None,
    collaboration: bool = True,
    team_brief: str | None = None,
) -> RunExecutor:
    """Build a :class:`RunExecutor` bound to one turn's wiring.

    Closes over ``plan`` so a node can resolve a dependency's display role when
    labelling injected upstream context; the scheduler passes only the terminal
    ``completed`` states per call.

    ``profile_set`` is the turn's resolved 质量档 (llm/modes.py): a worker's tier
    (fast/strong) is mapped to its model through it, so the user's selection reaches
    every delegated worker.

    ``approval_gate`` gates this team's GRANTABLE tool calls (``code_execute`` /
    ``file_write`` / ``str_replace``). It is the *same* per-turn gate the CEO uses,
    passed only in **local mode** (双模式工作区 P2d 执行门) so a delegated worker
    can never run code or mutate files on the user's real machine without consent;
    in cloud mode it is ``None`` (workers stay un-gated — the server sandbox is
    isolated). A shared gate means one "allow for the rest of this turn" covers the
    whole team.

    ``delegate_factory`` (when given) enables one nested delegation level (阶段2
    嵌套子任务): a worker that opted in (``spec.can_delegate``) and is still above
    the depth cap (``spec.depth < MAX_DELEGATION_DEPTH``) is handed its OWN
    ``delegate`` tool, bound to itself as the sub-team's captain. Leaf workers and
    depth-capped workers never receive it, so the tree can never nest past
    CEO → worker → sub-worker.

    ``interaction_bridge`` + ``escalation_timeout`` + ``escalation_armed`` wire each
    worker's ``escalate(blocking=true)`` to suspend for the user (阻塞式求决策, 设计
    §4.2): the bridge is the SAME process-wide registry ``ask_user`` parks on, the
    timeout reuses ``ask_user``'s window, and ``armed`` is the live-user gate (=
    ``ask_user``'s). All ``None`` / ``0`` / ``False`` (CEO, standalone, un-armed
    autonomous turns) ⇒ a worker's blocking escalate degrades to non-blocking. A
    nested sub-team inherits the same wiring (its captain's DelegateTool forwards it),
    so a depth-2 worker can reach the user with no depth special-case.

    ``collaboration`` gates the 团队便签墙 soft-collaboration layer (§2.2 通). A fan-out
    of a COLLABORATING team (delegate) keeps it ``True``: one shared note wall + the
    post / read / amend_note tools on every worker so siblings align mid-flight. An
    ADVERSARIAL / independent batch passes ``False`` (debate: 正方 vs 反方 are opponents,
    not teammates, and already get the moderator's round-gated cross-side channel) ⇒ NO
    wall is built and the note tools are neither granted nor offered, so nothing posts,
    no ``team_note_posted`` fires, and opponents can't read each other's notes.
    """
    # None (standalone / tests) = the economy base set; production passes the
    # turn's resolved 质量档 from the delegate tool.
    profiles = profile_set or default_profile_set()

    # 并行写隔离·硬约束: one write-conflict guard for this batch (the executor's
    # lifetime), plus each node's transitive depends_on closure. Injected onto every
    # worker's tool context below so file_write refuses to let a concurrent sibling
    # silently overwrite a peer's file, while a downstream consolidating an upstream's
    # file (its ancestor) is still allowed.
    write_coordinator = WriteCoordinator()
    ancestors_by_id = _ancestors_by_id(plan)

    # 团队便签墙 (§2.2 通): one sticky-note wall for this batch (the executor's lifetime),
    # the soft-collaboration counterpart of write_coordinator's hard write-conflict guard.
    # Concurrent siblings broadcast one-line decisions / heads-ups onto it (post_note) and
    # see each other's fresh notes pushed in before their next step (推增量) — so the parallel
    # silos can build on each other's evolving work. Scoped to this fan-out: only the siblings
    # actually running in parallel here share it, never the whole tree. The delegate driver
    # (drive.py) OWNS it and passes it in so the CEO finalize can read the outstanding notes for
    # 合·对账 (§2.3); tests pass None → one is created here. A NON-collaborative batch
    # (collaboration=False, e.g. debate — 正反方是对手不是队友) gets NO wall: the note tools are
    # neither granted nor offered below, so nothing posts, no team_note_posted fires, and
    # opponents can't read each other's notes (debate's legit cross-side channel is the
    # moderator's round-gated feedback, not this wall).
    note_wall = (note_wall or NoteWall()) if collaboration else None

    # Per-turn snapshot of the workspace's PRE-EXISTING files (uploads / prior turns),
    # shared by every worker in this delegate batch. "What was already on disk when the
    # team started" doesn't change within the turn, so walk it ONCE (newest-first,
    # ``order="recent"``) instead of re-walking + re-stat-ing per worker — the cost the
    # mtime sort would otherwise multiply across a wave. Teammate products stay FRESH per
    # worker (from the completion map), so a later wave still sees earlier waves' landed
    # files via their ``files_touched``. Lazy + lock so concurrent wave-1 workers trigger
    # exactly one walk; best-effort (:func:`_safe_index_files` swallows failures → []).
    # Trade-off: a file a teammate wrote INDIRECTLY (code_execute side effect, not in
    # ``files_touched``) won't appear in a later wave's manifest — acceptable; the common
    # cases (uploads / prior turns / file_write products) are fully covered.
    _ambient_snapshot: dict[str, list[str]] = {}
    _ambient_lock = asyncio.Lock()

    async def _preexisting_files() -> list[str]:
        if "paths" in _ambient_snapshot:
            return _ambient_snapshot["paths"]
        async with _ambient_lock:
            if "paths" not in _ambient_snapshot:  # double-check after awaiting the lock
                _ambient_snapshot["paths"] = await _safe_index_files(base_tool_context.backend)
            return _ambient_snapshot["paths"]

    conversation_id = base_tool_context.conversation_id

    def _escalation_channel(
        run_id: str, agent_id: str, resolutions: dict[str, dict[str, Any]]
    ) -> EscalationChannel | None:
        """Wire one worker's ``escalate(blocking=true)`` to suspend for the user (设计 §4.2).

        ``None`` when no interaction bridge is wired (CEO / standalone / tests) — then the
        tool keeps its non-blocking behaviour. The returned channel carries ``armed`` (the
        live-user gate) and a ``request`` that owns the whole mechanism the tool stays clear
        of (引擎纯化): the per-turn concurrency cap, the suspend on the shared bridge, the
        ``escalation_required`` / ``escalation_resolved`` pair (单一发射者: emitted here, the
        awaiter, never the resolve route), and recording the disposition into ``resolutions``
        for the CEO-facing harvest.
        """
        bridge = interaction_bridge
        if bridge is None:
            return None

        async def _request(
            question: str,
            assumption: str,
            questions: list[dict[str, Any]],
            kind: str = "normal",
            awaiting: str = "user",
        ) -> EscalationOutcome:
            # Cap: count this conversation's already-parked blocking escalates. The check
            # and the suspend's create() run with no await between them (single loop), so
            # the count can't race (设计 §4.7). Over cap ⇒ degrade (proceed on assumption).
            who = awaiting if awaiting in ("user", "ceo") else "user"
            awaiting_ceo = who == "ceo"

            # D1: after ask_user soft-stop cancelled a parked worker, CEO may have
            # stashed a resolve_escalation answer — pick it up without re-suspending.
            if awaiting_ceo:
                from agentcore.runtime.coordination.session import active_coordination

                session = active_coordination(base_tool_context.execution_id)
                if session is not None:
                    stashed = session.take_stashed_resolution(run_id)
                    if stashed is not None:
                        answer = str(stashed.get("answer") or "").strip()
                        via_user = bool(stashed.get("via_user"))
                        esc_id = str(stashed.get("escalation_id") or new_id())
                        resolutions[question] = {"status": "resolved", "answer": answer}
                        sink.emit(
                            escalation_resolved(
                                run_id,
                                agent_id,
                                escalation_id=esc_id,
                                status="resolved",
                                answer=answer,
                                arbitrated_by="ceo",
                                via_user=via_user,
                            )
                        )
                        return EscalationOutcome(status="resolved", answer=answer)

            parked = sum(
                1
                for r in bridge.list_pending(conversation_id)
                if r.kind is InteractionKind.ESCALATION
            )
            if parked >= ESCALATION_CONCURRENCY_CAP:
                logger.info("worker.escalate.cap_degraded", run_id=run_id, parked=parked)
                return EscalationOutcome(status="degraded")
            escalation_id = new_id()
            esc_kind = kind if kind in ("normal", "scope", "dep") else "normal"

            if awaiting_ceo:
                from agentcore.runtime.coordination.bridge import (
                    post_escalation_to_coordination,
                )
                from agentcore.runtime.coordination.session import active_coordination

                session = active_coordination(base_tool_context.execution_id)
                if session is not None and session.active:
                    session.register_arbitration(
                        run_id,
                        escalation_id=escalation_id,
                        conversation_id=conversation_id,
                        question=question,
                        assumption=assumption,
                        kind=esc_kind,
                    )
                    post_escalation_to_coordination(
                        run_id=run_id,
                        role="",
                        kind=esc_kind,
                        question=question,
                        assumption=assumption,
                        blocking=True,
                        source="blocking_arbitrate",
                        execution_id=base_tool_context.execution_id,
                        escalation_id=escalation_id,
                    )

            via_user = False
            try:
                result = await bridge.suspend(
                    escalation_id,
                    conversation_id,
                    kind=InteractionKind.ESCALATION,
                    payload={
                        "escalation_id": escalation_id,
                        "run_id": run_id,
                        "agent_id": agent_id,
                        "question": question,
                        "assumption": assumption,
                        "questions": questions,
                        "kind": esc_kind,
                        "awaiting": who,
                    },
                    timeout=escalation_timeout,
                    on_suspended=lambda: sink.emit(
                        escalation_required(
                            run_id,
                            agent_id,
                            escalation_id=escalation_id,
                            question=question,
                            assumption=assumption,
                            questions=questions,
                            kind=esc_kind,
                            awaiting=who,
                        )
                    ),
                )
            except TimeoutError:
                status, answer = "timed_out", ""
            except asyncio.CancelledError:
                # ask_user soft-stop cancels the drive — keep journaled pending_arbitrations
                # so resume + resolve_escalation can stash/settle for a re-armed worker.
                raise
            else:
                # Assumed vs timed_out are distinct wire statuses (same worker fallback).
                if isinstance(result, dict) and result.get("use_assumption"):
                    status, answer = "assumed", ""
                elif isinstance(result, dict):
                    status, answer = "resolved", str(result.get("answer") or "").strip()
                    via_user = bool(result.get("via_user"))
                else:
                    status, answer = "resolved", str(result or "").strip()
            if awaiting_ceo:
                from agentcore.runtime.coordination.session import active_coordination

                session = active_coordination(base_tool_context.execution_id)
                if session is not None:
                    session.clear_arbitration(run_id)
            resolutions[question] = {"status": status, "answer": answer}
            logger.info(
                "worker.escalate.settled",
                run_id=run_id,
                escalation_id=escalation_id,
                status=status,
                awaiting=who,
                timeout_s=escalation_timeout,
            )
            sink.emit(
                escalation_resolved(
                    run_id,
                    agent_id,
                    escalation_id=escalation_id,
                    status=status,
                    answer=answer,
                    arbitrated_by="ceo" if awaiting_ceo else "user",
                    via_user=via_user if awaiting_ceo else None,
                )
            )
            return EscalationOutcome(
                status=status,
                answer=answer if status == "resolved" else None,
            )

        return EscalationChannel(armed=escalation_armed, request=_request)

    async def _execute_node(
        spec: RunSpec, completed: Mapping[str, RunState], agent_id: str
    ) -> RunState:
        sink.emit(
            run_started(
                spec.run_id,
                agent_id,
                parent_run_id=spec.parent_run_id,
                kind=spec.kind,
                replaces_run_id=spec.replaces_run_id,
            )
        )
        start = time.monotonic()
        deliverable = spec.deliverable
        # Hoisted out of the try so a hard exception can still bill what this run
        # already spent (B-deep 失败计费): ``run_usage``/``run_rounds`` accumulate the
        # completed contract-retry attempts, ``inflight`` mirrors the in-flight pass's
        # spend (filled by react_loop, read only if that pass raises), and
        # ``priced_model`` is the tier to price against once the profile resolves
        # (None before that → an early setup failure carries no usage to price).
        run_usage = TokenUsage()
        run_rounds = 0
        inflight: list[TokenUsage] = []
        priced_model: str | None = None
        # Hoisted so a mid-flight CancelledError can salvage partial transcript (run_redirect 热续写).
        messages: list[LLMMessage] = []
        # Live draft chunks (run_output_delta) — may exist before the final assistant
        # turn is appended to ``messages``; folded into salvage on redirect cancel.
        streamed_content: list[str] = []
        # 阻塞式求决策: this worker's blocking-escalate resolutions, keyed by question, so the
        # transcript harvest below can fold the user's answer / timeout disposition into
        # ``RunState.escalations`` for CEO synthesis — driven by the structured channel below,
        # NOT by re-parsing the tool result prose (防补丁绊线, 设计 §4.7). A worker is
        # sequential, so escalates land here in call order, one at a time.
        resolutions: dict[str, dict[str, Any]] = {}
        # Escalation Gate (routing Phase 1): scheme-layer signals collected during react
        # rounds, merged into RunState.escalations alongside transcript-harvested escalate
        # tool calls.
        gate_escalations: list[dict[str, Any]] = []
        intake_payload: dict[str, Any] | None = None
        # 受监督子计划 B: a lead's nested-delegation handle (delegate + replan + dispose),
        # hoisted so the finally can fold a sub-plan the lead yielded-but-never-resumed back
        # into the ledger before the parent absorbs this child (堵漏账). Stays None for a leaf
        # worker (no opt-in / at the depth cap / no factory wired).
        lead_subteam: LeadSubteam | None = None
        try:
            pref = (
                spec.model_preference.value
                if hasattr(spec.model_preference, "value")
                else str(spec.model_preference)
            )
            profile = profiles.agent(spec.model_preference)
            priced_model = spec.model or profiles.model_for(f"agent.{pref}")
            tool_ctx = replace(
                base_tool_context,
                run_id=spec.run_id,
                agent_id=agent_id,
                execution_id=execution_id,
                write_coordinator=write_coordinator,
                write_ancestors=ancestors_by_id.get(spec.run_id, frozenset()),
                # 升级实时可见: give this worker's escalate tool a live channel back to the
                # run's SSE stream. The executor owns event shape (引擎纯化) — escalate just
                # hands it the (question, assumption, blocking) triple. run_id/agent_id are
                # bound here so the team UI attributes the escalation to the right node.
                on_escalate=lambda question, assumption, blocking, kind="normal", _rid=spec.run_id, _aid=agent_id: (  # noqa: E501
                    sink.emit(
                        escalation_raised(
                            _rid,
                            _aid,
                            question=question,
                            assumption=assumption,
                            blocking=blocking,
                            kind=kind,
                        )
                    )
                ),
                # 阻塞式求决策: the suspend-for-the-user channel for escalate(blocking=true).
                # None when no bridge (CEO / tests) → escalate stays non-blocking.
                escalation=_escalation_channel(spec.run_id, agent_id, resolutions),
                # 团队便签墙 (§2.2 通): the batch wall this worker's post_note broadcasts onto,
                # its display role stamped on its notes (谁贴的), and a live emit so the
                # team-notes panel lights up the instant a note is pinned. The executor owns
                # event shape (引擎纯化) — post_note just hands it the TeamNote; run/agent come
                # off the note so the UI attributes it to the right sibling. The durable record
                # rides the journaled team_note_posted event emitted here.
                note_wall=note_wall,
                agent_role=spec.role or "",
                on_note=lambda note: sink.emit(
                    team_note_posted(
                        execution_id=execution_id,
                        note_id=note.note_id,
                        run_id=note.run_id,
                        agent_id=note.agent_id,
                        role=note.role,
                        kind=note.kind,
                        text=note.text,
                        ts=note.ts,
                        # 改写/作废 (§2.2 supersession): an amendment note carries the target it
                        # 改写/作废s + the mode; a fresh post leaves both None (omitted from the
                        # payload). The same on_note path serves post_note AND amend_note.
                        supersedes=note.supersedes,
                        supersede_mode=note.supersede_mode,
                    )
                ),
            )
            # 阶段2 嵌套子任务: hand this worker delegation tools when opted in.
            worker_tools = tools
            # spec.tools is None for an unrestricted worker → react_loop offers all
            # team tools (the fail-safe default); a non-empty list restricts to those.
            allowed_tools = spec.tools
            identity = _WORKER_IDENTITY
            if (
                delegate_factory is not None
                and spec.can_delegate is True
                and spec.depth < MAX_DELEGATION_DEPTH
            ):
                # The lead gets BOTH its own delegate AND the companion replan bound to
                # that delegate instance, so it supervises its sub-plan's 波边界
                # (bind_after_deps / 子队员 escalate scope) exactly like the CEO
                # (受监督子计划 B 去特例). Its turn-end dispose runs in the finally below.
                lead_subteam = delegate_factory(spec.run_id, spec.depth)
                worker_tools = _registry_with(tools, *lead_subteam.tools)
                # Unrestricted (None) stays None — the new tools now live in worker_tools,
                # so "offer all" already includes them. A restricted list must explicitly
                # gain their names (delegate + replan) to keep them callable.
                allowed_tools = (
                    None if spec.tools is None else [*spec.tools, *lead_subteam.tool_names]
                )
                identity = _WORKER_CAPTAIN_IDENTITY
            if not collaboration:
                identity = identity.replace(_WORKER_TEAM_NOTE_POLICY, "").replace("\n\n\n", "\n\n")
            # 非协作批次 (collaboration=False, e.g. debate): strip the 团队便签 tools from the
            # offered registry so even an UNRESTRICTED worker (allowed_tools=None → "offer all
            # team tools") is never handed post/read/amend — "no collaboration" means no channel
            # at all, not "no channel only for a least-privilege worker". Restricted workers are
            # covered by skipping the grants below; this closes the unrestricted path too.
            if not collaboration:
                worker_tools = _registry_without(
                    worker_tools,
                    POST_NOTE_TOOL_NAME,
                    READ_NOTES_TOOL_NAME,
                    AMEND_NOTE_TOOL_NAME,
                )
            # escalate is a worker's always-available upward channel — a safety primitive,
            # not a capability the CEO restricts away. An unrestricted worker (None) is
            # already offered it; a least-privilege worker (non-empty allow-list) must
            # keep it explicitly, so it can still flag a blocker instead of guessing.
            if allowed_tools is not None and ESCALATE_TOOL_NAME not in allowed_tools:
                allowed_tools = [*allowed_tools, ESCALATE_TOOL_NAME]
            # 团队便签三件套 (post/read/amend_note) 仅协作批次授予 (便签墙 broadcast, §2.2 通): a
            # collaborating team keeps them always-available even for a least-privilege worker so
            # siblings align mid-flight; a non-collaborative batch (collaboration=False, e.g.
            # debate) skips them entirely — they are also stripped from worker_tools above, so an
            # unrestricted worker in such a batch isn't offered them either (opponents get no
            # 便签 channel).
            if collaboration:
                if allowed_tools is not None and POST_NOTE_TOOL_NAME not in allowed_tools:
                    allowed_tools = [*allowed_tools, POST_NOTE_TOOL_NAME]
                # read_notes is post_note's pull dual (§2.4 变·worker 的「拉」): even a
                # least-privilege worker can look up what a sibling already decided.
                if allowed_tools is not None and READ_NOTES_TOOL_NAME not in allowed_tools:
                    allowed_tools = [*allowed_tools, READ_NOTES_TOOL_NAME]
                # amend_note completes the trio (便签会过期 → 改写/作废, §2.2 supersession): a
                # worker must be able to correct its OWN stale note so a sibling never builds on
                # a dead decision.
                if allowed_tools is not None and AMEND_NOTE_TOOL_NAME not in allowed_tools:
                    allowed_tools = [*allowed_tools, AMEND_NOTE_TOOL_NAME]
            from agentcore.runtime.audit.hooks import on_permission_effective

            on_permission_effective(
                execution_id=execution_id,
                run_id=spec.run_id,
                parent_run_id=spec.parent_run_id,
                declared_tools=None if spec.tools is None else list(spec.tools),
                effective_tools=None if allowed_tools is None else list(allowed_tools),
                can_delegate=spec.can_delegate,
                depth=spec.depth,
            )
            # Produce → check contract → re-prompt with the specific shortfalls.
            # This content-quality retry is intentionally separate from the
            # scheduler's infra-failure retry (RunPolicy.on_failure): they answer
            # different questions and must not be conflated.
            content = ""
            # The worker's full thinking from the LAST attempt (parallel to
            # ``content``, which each attempt overwrites): carried onto the terminal
            # RunState → its ``message_final`` fact so resume / reload rebuild the
            # worker's 思考全文 from the journal, not from the (being-retired)
            # ``run_reasoning_delta`` stream (执行级事件溯源: deltas 退场).
            reasoning = ""
            verdict = ContractVerdict(ok=True)
            # Web sources this worker consults, de-duped across contract retries.
            # Collect-only (annotate_citations=False): the worker text stays
            # un-numbered; the DelegateTool folds these into the turn's shared
            # source card so the user sees the WHOLE team's research, not just the
            # CEO's own searches.
            worker_citations: list[dict] = []
            # Pre-existing workspace files (uploads / prior turns) for the worker's
            # opening manifest — a per-turn snapshot walked once and shared by the whole
            # batch (see ``_preexisting_files``); peer products are layered on per worker
            # from the completion map inside ``_build_messages``.
            index_paths = await _preexisting_files()
            # Build the worker's opening (system + task) ONCE; auto-rework then
            # CONTINUES on this SAME transcript (append the shortfall, re-run)
            # instead of rebuilding from scratch — so the worker sees its own prior
            # draft when correcting (修隐患), and the finished transcript is captured
            # as a recoverable RunSession for 定向唤回 (统一「续写」原语, 见 §三).
            # received_blocks captures the SAME ContextBlocks the opening was rendered
            # from (单一源), so the run_context event ships exactly what the LLM was fed.
            received_blocks: list[ContextBlock] = []
            messages[:] = _build_messages(
                plan,
                spec,
                completed,
                system_prompt,
                user_message,
                deliverable,
                identity=identity,
                index_paths=index_paths,
                blocks_sink=received_blocks,
                team_brief=team_brief,
            )
            # 上下文传递可视化: emit the received context right after assembly (before the
            # LLM react loop) so the frontend's run detail lights up its「收到的上下文」as
            # soon as the worker starts thinking. Bodies capped + journaled (see run_context).
            sink.emit(run_context(spec.run_id, agent_id, _context_block_payloads(received_blocks)))

            # Worker 内部路由 Phase 1 · Intake：轻量计划头（复杂度 / 策略 / token 预算）。
            # 挂在执行上下文（RunState.intake），经 run_intake 事件发射；不产出逐步计划。
            intake_result = assess_intake(
                task=spec.task,
                role=spec.role,
                objective=spec.objective,
                tools=spec.tools,
            )
            intake_payload = intake_result.to_event_payload()
            sink.emit(
                run_intake(
                    spec.run_id,
                    agent_id,
                    complexity=intake_result.complexity.value,
                    strategy=intake_result.strategy.value,
                    token_budget=intake_result.token_budget,
                    rationale=intake_result.rationale,
                    signals=intake_result.signals,
                )
            )
            # Worker 硬顶 (loose backstop · 真执行): 累计 token 安全阀。compaction
            # (tool_clear) 挑大梁做上下文瘦身,这只在失控时 (估计再离谱也炸不穿 clamp) 收口。
            # 0 = 关闭。react_loop 每轮末比对累计 usage。
            token_ceiling = resolve_worker_token_ceiling(intake_result.token_budget)

            # 团队便签墙 推增量 (§2.2 通): pull the notes siblings posted since this worker last
            # looked and hand them to react_loop as one user message before each of its NEXT
            # steps — so it builds on the team's evolving decisions / heads-ups, not a snapshot
            # frozen at its opening. new_for already excludes self-posted, caps the burst, and
            # advances this run's cursor (each note delivered at most once). Empty (solo / no
            # fresh notes) → [] → a no-op round, identical to today's behaviour.
            _note_nudged: list[bool] = [False]

            def _pull_notes(_rid: str = spec.run_id) -> list[LLMMessage]:
                if note_wall is None:  # 非协作批次 (collaboration=False): no wall → nothing to push
                    return []
                injected: list[LLMMessage] = []
                fresh = note_wall.new_for(_rid)
                if fresh:
                    injected.append(
                        LLMMessage(role="user", content=format_notes_for_injection(fresh))
                    )
                if (
                    not _note_nudged[0]
                    and not note_wall.own_active(_rid)
                    and len(note_wall.all_for(_rid)) >= 2
                ):
                    _note_nudged[0] = True
                    injected.append(LLMMessage(role="user", content=NOTE_NUDGE_TEXT))
                return injected

            attempts = 1 + min(DEFAULT_CONTRACT_RETRIES, MAX_CONTRACT_RETRIES)
            for attempt in range(attempts):
                streamed_content.clear()
                content, reasoning, round_usage, round_rounds = await _react_and_capture(
                    messages,
                    llm=llm,
                    tools=worker_tools,
                    sink=sink,
                    tool_ctx=tool_ctx,
                    profile=profile,
                    turn_model=priced_model,
                    allowed_tools=allowed_tools,
                    run_id=spec.run_id,
                    agent_id=agent_id,
                    citation_sink=worker_citations,
                    approval_gate=approval_gate,
                    usage_sink=inflight,
                    on_round_begin=_pull_notes,
                    streamed_content=streamed_content,
                    gate_escalation_sink=gate_escalations,
                    token_budget=token_ceiling,
                )
                run_usage = run_usage + round_usage
                run_rounds += round_rounds
                # This pass's usage is now folded into run_usage via its return value;
                # drop the mirror so a later non-react raise can't double-count it.
                inflight.clear()
                # files_written backs the contract's requires_files gate: derived
                # from this transcript's file-tool calls so a file deliverable that
                # was only pasted into the reply (never written) fails and reworks.
                verdict = check_contract(
                    content,
                    deliverable,
                    files_written=len(files_touched_from_transcript(messages)),
                    debrief=debrief_from_transcript(messages),
                )
                if verdict.ok or attempt == attempts - 1:
                    break
                messages.append(_retry_message(format_feedback(verdict)))
                logger.info(
                    "contract.retry",
                    run_id=spec.run_id,
                    attempt=attempt + 1,
                    failures=verdict.failures,
                )

            duration_ms = int((time.monotonic() - start) * 1000)
            # Price this run once (the only place a worker's cost is computed),
            # carried on the state so the per-run ledger and UI payroll read it
            # without re-pricing. Cost is recorded even on FAILED so a stopped
            # run still shows what it已花费.
            usage = run_usage.as_dict()
            cost = asdict(calculate_cost(priced_model, run_usage))
            # Upward escalations this worker raised (escalate tool calls), harvested
            # once from the transcript and carried on BOTH terminal states — a worker
            # that flags a blocker then fails its contract should still surface that
            # blocker to the CEO. 阻塞式求决策: fold each blocking escalate's resolution
            # (answer / timeout) in by question, so CEO synthesis knows which were already
            # settled with the user and must not be re-asked (设计 §4.5/§4.7).
            escalations = escalations_from_transcript(messages)
            for esc in escalations:
                settled = resolutions.get(esc.get("question", ""))
                if settled is not None:
                    esc["status"] = settled["status"]
                    esc["answer"] = settled["answer"]
            # Merge Escalation Gate scheme-layer signals (dedupe by question).
            seen_questions = {e.get("question", "") for e in escalations}
            for gate_esc in gate_escalations:
                q = gate_esc.get("question", "")
                if q and q not in seen_questions:
                    escalations.append(gate_esc)
                    seen_questions.add(q)
            # 完工交接简报: harvest the worker's structured brief from its ``handoff`` tool call
            # (best-effort; None when it finished without one) so downstream dep injection / CEO
            # synthesis read the author's own 结论 + 建议下一步 instead of re-deriving them from
            # prose. Carried on BOTH terminal states (a worker that failed its contract can still
            # have submitted a useful brief before failing).
            debrief = debrief_from_transcript(messages)
            if not verdict.ok and _is_hard_failure(content, deliverable):
                reason = "；".join(verdict.failures)
                logger.info("contract.failed", run_id=spec.run_id, failures=verdict.failures)
                # A contract miss still produced a deliverable + (often) a 交接简报: surface it so
                # the run-detail shows the author's wrap-up beside the failure (the infra-failure
                # except path below has no reliable content, so it carries none).
                sink.emit(run_failed(spec.run_id, agent_id, reason, debrief=debrief))
                return RunState(
                    phase=RunPhase.FAILED,
                    content=content,
                    reasoning=reasoning,
                    error=reason,
                    escalations=escalations,
                    debrief=debrief,
                    citations=worker_citations,
                    model=priced_model,
                    duration_ms=duration_ms,
                    rounds=run_rounds,
                    usage=usage,
                    cost=cost,
                    transcript=messages,
                    received_context=received_blocks,
                    intake=intake_payload,
                )
            # The worker's terminal RunState is journaled at the ``execute`` choke point
            # below (run_final_fact — covers COMPLETED *and* FAILED in one place), so resume
            # re-seeds it from facts not the旁路 frame (执行级事件溯源 Phase 2 ⑥).
            touched = files_touched_from_transcript(messages)
            sink.emit(
                run_completed(
                    spec.run_id,
                    agent_id,
                    # 交接简报单一源: the summary IS the worker's authored 结论 (best-effort "" when
                    # it wrote none — the full deliverable is persisted + shown either way), never a
                    # truncation; the structured debrief rides alongside for the run-detail card.
                    output_summary=(debrief or {}).get("summary", ""),
                    duration_ms=duration_ms,
                    # 阶段1 scheduled runs are all delegated workers → member row;
                    # the already-priced usage/cost light up the payroll live.
                    role="member",
                    model=priced_model,
                    usage=usage,
                    cost=cost,
                    debrief=debrief,
                    output_files=touched or None,
                )
            )
            return RunState(
                phase=RunPhase.COMPLETED,
                content=content,
                reasoning=reasoning,
                warnings=[] if verdict.ok else list(verdict.failures),
                escalations=escalations,
                debrief=debrief,
                citations=worker_citations,
                model=priced_model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                files_touched=touched,
                usage=usage,
                cost=cost,
                transcript=messages,
                received_context=received_blocks,
                intake=intake_payload,
            )
        except asyncio.CancelledError as e:
            # Dual cancel semantics: redirect = salvage + return CANCELLED (wave absorbs);
            # stop (整轮) = emit run_cancelled then re-raise so the turn abort propagates.
            cancel_reason = (
                "redirect"
                if e.args and str(e.args[0]) == "redirect"
                else "stop"
            )
            sink.emit(
                run_cancelled(spec.run_id, agent_id, reason=cancel_reason)
            )
            if cancel_reason == "redirect":
                # Fold live streamed draft into messages when the ReAct pass was cut
                # before the final assistant turn was appended (用户已看见的一半产出).
                draft = "".join(streamed_content).strip()
                salvage_msgs = list(messages)
                if draft and not any(m.role in ("assistant", "tool") for m in salvage_msgs):
                    salvage_msgs.append(LLMMessage(role="assistant", content=draft))
                session = try_salvage_session(spec=spec, messages=salvage_msgs)
                logger.info(
                    "run.redirect_cancelled",
                    run_id=spec.run_id,
                    salvage=session is not None,
                    transcript_len=len(session.transcript) if session else 0,
                    streamed_chars=len(draft),
                )
                return cancelled_state_from_salvage(session, error="redirected")
            raise
        except Exception as e:  # noqa: BLE001 — surface any run failure to UI/state
            duration_ms = int((time.monotonic() - start) * 1000)
            # Bill the rounds that completed before the failure: finished attempts are
            # already in run_usage; an in-flight pass that raised left its spend in
            # ``inflight`` (B-deep 失败计费).
            if inflight:
                run_usage = run_usage + inflight[0]
            # 确定性失败区分 (BL-6): a non-retryable upstream error (prompt 超长 / 400 /
            # 鉴权 / 余额 — AgentCoreError.retryable=False) will re-fail identically, so
            # carry that verdict onto the state and let the scheduler skip its infra retry.
            # A plain crash / unknown exception has no ``retryable`` attr → defaults True
            # (retry as before), so only KNOWN-deterministic failures opt out.
            retryable = bool(getattr(e, "retryable", True))
            logger.error(
                "run.failed",
                run_id=spec.run_id,
                error=str(e),
                retryable=retryable,
                exc_info=True,
            )
            sink.emit(run_failed(spec.run_id, agent_id, str(e)))
            return _priced_failure(
                str(e),
                model=priced_model,
                usage=run_usage,
                rounds=run_rounds,
                duration_ms=duration_ms,
                retryable=retryable,
            )
        finally:
            # 堵漏账: if this lead opened a sub-plan at a 波边界 but its react loop ended
            # without a final replan (answered directly / hit MAX_ROUNDS / raised), the held
            # sub-team spend still sits in the child delegate's _supervised. Fold it in now —
            # BEFORE the parent drive's absorb_children merges this child's ledger — so no
            # sub-team usage is stranded unbilled. No-op when nothing is paused; best-effort,
            # and in a finally so it runs on the success, MAX_ROUNDS, and exception paths alike.
            if lead_subteam is not None:
                await lead_subteam.dispose()

    async def execute(spec: RunSpec, completed: Mapping[str, RunState]) -> RunState:
        # Bind this worker's identity so EVERY log emitted under it (tool.execute_end,
        # contract.*, run.*, llm.*, react_loop internals) carries run_id/agent_id/
        # depth — analysis can then split tool quality + events by worker. The scope
        # auto-clears on exit; contextvars are task-local, so concurrent workers in a
        # wave never bleed identities into one another.
        agent_id = spec.agent_id or spec.run_id
        with log_context(run_id=spec.run_id, agent_id=agent_id, depth=spec.depth):
            state = await _execute_node(spec, completed, agent_id)
            # 执行级事件溯源 Phase 2 ⑥: journal the worker's terminal RunState (the seed shape)
            # at the SINGLE run choke point — every phase (COMPLETED / FAILED) covered once —
            # so a resume re-seeds finished nodes from facts (completed_from_journal), not the
            # 旁路 ``frame.completed``. The heavy transcript is dropped by ``state_to_json``.
            record_turn_fact(run_final_fact(spec.run_id, state))
            return state

    return execute
