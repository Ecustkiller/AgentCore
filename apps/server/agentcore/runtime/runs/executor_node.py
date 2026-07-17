"""Single AGENT-node execution (contract retries, escalate, notes, salvage)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import asdict, replace
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage
from agentcore.runtime.debate.speech_pipeline import research_then_draft
from agentcore.runtime.events import (
    FinishReason,
    escalation_raised,
    run_cancelled,
    run_completed,
    run_context,
    run_failed,
    run_started,
    team_note_posted,
)
from agentcore.runtime.runs.constants import (
    AMEND_NOTE_TOOL_NAME,
    DEFAULT_CONTRACT_RETRIES,
    ESCALATE_TOOL_NAME,
    HANDOFF_TOOL_NAME,
    MAX_CONTRACT_RETRIES,
    MAX_DELEGATION_DEPTH,
    POST_NOTE_TOOL_NAME,
    READ_NOTES_TOOL_NAME,
)
from agentcore.runtime.runs.contract import (
    ContractVerdict,
    check_contract,
    debrief_meets_minimum,
    format_feedback,
    format_handoff_feedback,
    node_has_dependents,
    synthesize_debrief,
)
from agentcore.runtime.runs.executor_context import (
    _build_messages,
    _context_block_payloads,
    _load_artifact_contents,
    _safe_index_files,
)
from agentcore.runtime.runs.executor_env import AgentExecutorEnv
from agentcore.runtime.runs.executor_escalation import build_escalation_channel
from agentcore.runtime.runs.executor_identities import (
    _WORKER_TEAM_NOTE_POLICY,
    LeadSubteam,
    build_worker_identity,
)
from agentcore.runtime.runs.executor_shared import (
    _apply_finish_interrupt,
    _is_hard_failure,
    _priced_failure,
    _react_and_capture,
    _registry_with,
    _registry_without,
    _retry_message,
)
from agentcore.runtime.runs.notewall import NOTE_NUDGE_TEXT, format_notes_for_injection
from agentcore.runtime.runs.salvage import cancelled_state_from_salvage, try_salvage_session
from agentcore.runtime.runs.serialize import (
    debrief_from_transcript,
    escalations_from_transcript,
    files_touched_from_transcript,
)
from agentcore.runtime.runs.types import ContextBlock, RunPhase, RunSpec, RunState

logger = get_logger(__name__)


async def execute_agent_node(
    env: AgentExecutorEnv,
    spec: RunSpec,
    completed: Mapping[str, RunState],
    agent_id: str,
) -> RunState:
    env.sink.emit(
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
    # Hoisted so mid-flight CancelledError can salvage partial transcript (run_redirect 热续写).
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
        profile = env.profiles.agent(spec.model_preference)
        priced_model = spec.model or env.profiles.model_for(f"agent.{pref}")
        tool_ctx = replace(
            env.base_tool_context,
            run_id=spec.run_id,
            agent_id=agent_id,
            execution_id=env.execution_id,
            write_coordinator=env.write_coordinator,
            write_ancestors=env.ancestors_by_id.get(spec.run_id, frozenset()),
            # 升级实时可见: give this worker's escalate tool a live channel back to the
            # run's SSE stream. The executor owns event shape (引擎纯化) — escalate just
            # hands it the (question, assumption, blocking) triple. run_id/agent_id are
            # bound here so the team UI attributes the escalation to the right node.
            on_escalate=lambda question, assumption, blocking, kind="normal", _rid=spec.run_id, _aid=agent_id: (  # noqa: E501
                env.sink.emit(
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
            escalation=build_escalation_channel(env, spec.run_id, agent_id, resolutions),
            # 团队便签墙 (§2.2 通): the batch wall this worker's post_note broadcasts onto,
            # its display role stamped on its notes (谁贴的), and a live emit so the
            # team-notes panel lights up the instant a note is pinned. The executor owns
            # event shape (引擎纯化) — post_note just hands it the TeamNote; run/agent come
            # off the note so the UI attributes it to the right sibling. The durable record
            # rides the journaled team_note_posted event emitted here.
            note_wall=env.note_wall,
            agent_role=spec.role or "",
            on_note=lambda note: env.sink.emit(
                team_note_posted(
                    execution_id=env.execution_id,
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
        worker_tools = env.tools
        # spec.tools is None for an unrestricted worker → react_loop offers all
        # team tools (the fail-safe default); a non-empty list restricts to those.
        allowed_tools = spec.tools
        is_captain = (
            env.delegate_factory is not None
            and spec.can_delegate is True
            and spec.depth < MAX_DELEGATION_DEPTH
        )
        if is_captain:
            # The lead gets BOTH its own delegate AND the companion replan bound to
            # that delegate instance, so it supervises its sub-plan's 波边界
            # (bind_after_deps / 子队员 escalate scope) exactly like the CEO
            # (受监督子计划 B 去特例). Its turn-end dispose runs in the finally below.
            lead_subteam = env.delegate_factory(spec.run_id, spec.depth)
            worker_tools = _registry_with(env.tools, *lead_subteam.tools)
            # Unrestricted (None) stays None — the new tools now live in worker_tools,
            # so "offer all" already includes them. A restricted list must explicitly
            # gain their names (delegate + replan) to keep them callable.
            allowed_tools = (
                None if spec.tools is None else [*spec.tools, *lead_subteam.tool_names]
            )
        # Topology-split handoff wording + deliverable.form: DAG is known at identity
        # build — upstream nodes get imperative「必须 handoff」; leaves get conditional
        # 「有增量才写」. form=prose/files selects the landing block (omit = legacy).
        deliverable_form = (
            spec.deliverable.form if spec.deliverable is not None else None
        )
        identity = build_worker_identity(
            has_dependents=node_has_dependents(env.plan, spec.run_id),
            captain=is_captain,
            form=deliverable_form,
            # 能写≠能跑 (能力闸门与交付诚实性): the registry is the capability truth —
            # execution class absent (cloud without sandbox) ⇒ the identity says so,
            # instead of the generic wording implying the worker can run code.
            can_execute=env.tools.get_optional("code_execute") is not None,
        )
        if not env.collaboration:
            identity = identity.replace(_WORKER_TEAM_NOTE_POLICY, "").replace("\n\n\n", "\n\n")
        # form=prose: withhold write tools (hard constraint — not just prompt).
        if deliverable_form == "prose":
            from agentcore.runtime.runs.executor_identities import (
                PROSE_WITHHELD_WRITE_TOOLS,
            )

            worker_tools = _registry_without(
                worker_tools, *PROSE_WITHHELD_WRITE_TOOLS
            )
            if allowed_tools is not None:
                withheld = set(PROSE_WITHHELD_WRITE_TOOLS)
                allowed_tools = [t for t in allowed_tools if t not in withheld]
        # 非协作批次 (env.collaboration=False, e.g. debate): strip the 团队便签 tools from the
        # offered registry so even an UNRESTRICTED worker (allowed_tools=None → "offer all
        # team tools") is never handed post/read/amend — "no env.collaboration" means no channel
        # at all, not "no channel only for a least-privilege worker". Restricted workers are
        # covered by skipping the grants below; this closes the unrestricted path too.
        if not env.collaboration:
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
        # siblings align mid-flight; a non-collaborative batch (env.collaboration=False, e.g.
        # debate) skips them entirely — they are also stripped from worker_tools above, so an
        # unrestricted worker in such a batch isn't offered them either (opponents get no
        # 便签 channel).
        if env.collaboration:
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
            execution_id=env.execution_id,
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
        # batch (see ``env.preexisting_files``); peer products are layered on per worker
        # from the completion map inside ``_build_messages``.
        index_paths = await env.preexisting_files()
        # Build the worker's opening (system + task) ONCE; auto-rework then
        # CONTINUES on this SAME transcript (append the shortfall, re-run)
        # instead of rebuilding from scratch — so the worker sees its own prior
        # draft when correcting (修隐患), and the finished transcript is captured
        # as a recoverable RunSession for 定向唤回 (统一「续写」原语, 见 §三).
        # received_blocks captures the SAME ContextBlocks the opening was rendered
        # from (单一源), so the run_context event ships exactly what the LLM was fed.
        received_blocks: list[ContextBlock] = []
        messages[:] = _build_messages(
            env.plan,
            spec,
            completed,
            env.system_prompt,
            env.user_message,
            deliverable,
            identity=identity,
            index_paths=index_paths,
            blocks_sink=received_blocks,
            team_brief=env.team_brief,
            shared_workspace=env.shared_workspace,
        )
        # 上下文传递可视化: emit the received context right after assembly (before the
        # LLM react loop) so the frontend's run detail lights up its「收到的上下文」as
        # soon as the worker starts thinking. Bodies capped + journaled (see run_context).
        env.sink.emit(run_context(spec.run_id, agent_id, _context_block_payloads(received_blocks)))

        # Worker 累计 token 硬顶 (loose backstop · 真执行): 统一可配置上限。compaction
        # (tool_clear) 挑大梁做上下文瘦身,这只在失控时收口。≤0 = 关闭。
        # react_loop 每轮末比对累计 usage。CEO / solo 路径不经此分支,保持 0。
        # 辩论辩手两阶段检索：独立 ``engine_debate_token_ceiling``（默认高于通用 worker 顶），
        # 避免长取证与 worker 80k 合用导致首轮检索过早 ceiling_finalize。
        if spec.research_then_draft:
            token_ceiling = (
                settings.engine_debate_token_ceiling
                if settings.engine_debate_token_ceiling > 0
                else 0
            )
        else:
            token_ceiling = (
                settings.engine_worker_token_ceiling
                if settings.engine_worker_token_ceiling > 0
                else 0
            )

        # 团队便签墙 推增量 (§2.2 通): pull the notes siblings posted since this worker last
        # looked and hand them to react_loop as one user message before each of its NEXT
        # steps — so it builds on the team's evolving decisions / heads-ups, not a snapshot
        # frozen at its opening. new_for already excludes self-posted, caps the burst, and
        # advances this run's cursor (each note delivered at most once). Empty (solo / no
        # fresh notes) → [] → a no-op round, identical to today's behaviour.
        _note_nudged: list[bool] = [False]

        def _pull_notes(_rid: str = spec.run_id) -> list[LLMMessage]:
            if env.note_wall is None:  # non-collaborative batch: no wall to push
                return []
            injected: list[LLMMessage] = []
            fresh = env.note_wall.new_for(_rid)
            if fresh:
                injected.append(
                    LLMMessage(role="user", content=format_notes_for_injection(fresh))
                )
            if (
                not _note_nudged[0]
                and not env.note_wall.own_active(_rid)
                and len(env.note_wall.all_for(_rid)) >= 2
            ):
                _note_nudged[0] = True
                injected.append(LLMMessage(role="user", content=NOTE_NUDGE_TEXT))
            return injected

        attempts = 1 + min(DEFAULT_CONTRACT_RETRIES, MAX_CONTRACT_RETRIES)
        # Accepted react pass's finish override (cleared each attempt so a clean
        # rework after an interrupted first pass does not keep the interrupt warning).
        finish_override: list[FinishReason] = []
        for attempt in range(attempts):
            streamed_content.clear()
            finish_override.clear()
            if spec.research_then_draft and (spec.draft_brief or "").strip():
                content, reasoning, round_usage, round_rounds = await research_then_draft(
                    messages,
                    llm=env.llm,
                    tools=worker_tools,
                    sink=env.sink,
                    tool_ctx=tool_ctx,
                    profile=profile,
                    turn_model=priced_model,
                    allowed_tools=allowed_tools,
                    run_id=spec.run_id,
                    agent_id=agent_id,
                    citation_sink=worker_citations,
                    approval_gate=env.approval_gate,
                    draft_system=spec.draft_system or (spec.system_prompt_supplement or ""),
                    draft_brief=spec.draft_brief,
                    allow_research=True,
                    check_source_grounding=spec.source_grounding_check,
                    usage_sink=inflight,
                    on_round_begin=_pull_notes,
                    streamed_content=streamed_content,
                    gate_escalation_sink=gate_escalations,
                    token_budget=token_ceiling,
                    finish_override_sink=finish_override,
                )
            else:
                content, reasoning, round_usage, round_rounds = await _react_and_capture(
                    messages,
                    llm=env.llm,
                    tools=worker_tools,
                    sink=env.sink,
                    tool_ctx=tool_ctx,
                    profile=profile,
                    turn_model=priced_model,
                    allowed_tools=allowed_tools,
                    run_id=spec.run_id,
                    agent_id=agent_id,
                    citation_sink=worker_citations,
                    approval_gate=env.approval_gate,
                    usage_sink=inflight,
                    on_round_begin=_pull_notes,
                    streamed_content=streamed_content,
                    gate_escalation_sink=gate_escalations,
                    token_budget=token_ceiling,
                    finish_override_sink=finish_override,
                )
            run_usage = run_usage + round_usage
            run_rounds += round_rounds
            # This pass's usage is now folded into run_usage via its return value;
            # drop the mirror so a later non-react raise can't double-count it.
            inflight.clear()
            # files_written backs the contract's requires_files gate; workspace_paths
            # reconciles declarative artifacts against the live workspace (+ this
            # run's own writes). Handoff gate: nodes with downstream dependents must
            # submit a minimum-quality brief (one correction shot, then degraded synth).
            touched_now = files_touched_from_transcript(messages)
            debrief_now = debrief_from_transcript(messages)
            # Re-index the live workspace only when reconciling declarative
            # artifacts — otherwise keep the once-per-turn opening snapshot
            # (peer/preexisting manifest) and this run's own writes.
            artifact_contents: dict[str, str] | None = None
            if deliverable and deliverable.artifacts:
                live_index = await _safe_index_files(tool_ctx.backend)
                workspace_paths = list(dict.fromkeys([*live_index, *touched_now]))
                if deliverable.output_format == "json":
                    artifact_contents = await _load_artifact_contents(
                        tool_ctx.backend,
                        deliverable.artifacts,
                        workspace_paths,
                    )
            else:
                workspace_paths = list(touched_now)
            verdict = check_contract(
                content,
                deliverable,
                files_written=len(touched_now),
                debrief=debrief_now,
                workspace_paths=workspace_paths,
                artifact_contents=artifact_contents,
            )
            # Handoff gate only forces a correction shot when the tool is actually
            # offered (production worker registry). Empty-registry unit tests still
            # get a degraded synth below without burning an extra LLM round.
            needs_handoff = node_has_dependents(env.plan, spec.run_id)
            handoff_offered = worker_tools.get_optional(HANDOFF_TOOL_NAME) is not None
            handoff_ok = (
                (not needs_handoff)
                or debrief_meets_minimum(debrief_now)
                or not handoff_offered
            )
            if (verdict.ok and handoff_ok) or attempt == attempts - 1:
                break
            parts: list[str] = []
            if not verdict.ok:
                parts.append(format_feedback(verdict))
            if needs_handoff and handoff_offered and not debrief_meets_minimum(debrief_now):
                parts.append(
                    format_handoff_feedback(present_but_thin=debrief_now is not None)
                )
            messages.append(_retry_message("\n\n".join(p for p in parts if p)))
            logger.info(
                "contract.retry",
                run_id=spec.run_id,
                attempt=attempt + 1,
                failures=verdict.failures,
                handoff_ok=handoff_ok,
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
        # have submitted a useful brief before failing). Nodes with downstream dependents
        # that still lack a minimum-quality brief get an engine-synthesized degraded debrief.
        debrief = debrief_from_transcript(messages)
        touched = files_touched_from_transcript(messages)
        author_brief = debrief
        if node_has_dependents(env.plan, spec.run_id) and not debrief_meets_minimum(debrief):
            debrief = synthesize_debrief(content, touched)
            logger.info(
                "handoff.degraded_synth",
                run_id=spec.run_id,
                had_author_brief=author_brief is not None,
            )
        if not verdict.ok and _is_hard_failure(content, deliverable):
            reason = "；".join(verdict.failures)
            logger.info("contract.failed", run_id=spec.run_id, failures=verdict.failures)
            # A contract miss still produced a deliverable + (often) a 交接简报: surface it so
            # the run-detail shows the author's wrap-up beside the failure (the infra-failure
            # except path below has no reliable content, so it carries none).
            env.sink.emit(run_failed(spec.run_id, agent_id, reason, debrief=debrief))
            # Contract retries already exhausted inside this executor; mark
            # non-retryable so WaveScheduler's on_failure=retry does not cold-
            # start the whole node (same tokens, same empty/short product).
            return RunState(
                phase=RunPhase.FAILED,
                content=content,
                reasoning=reasoning,
                error=reason,
                error_retryable=False,
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
            )
        # Soft-accept / clean complete: still surface an interrupted LLM finish so CEO
        # synthesis sees the gap (files may be on disk but handoff missing/thin).
        warnings = [] if verdict.ok else list(verdict.failures)
        warnings, debrief = _apply_finish_interrupt(
            finish_override,
            warnings=warnings,
            debrief=debrief,
            content=content,
            files_touched=touched,
            run_id=spec.run_id,
        )
        # The worker's terminal RunState is journaled at the ``execute`` choke point
        # below (run_final_fact — covers COMPLETED *and* FAILED in one place), so resume
        # re-seeds it from facts not the旁路 frame (执行级事件溯源 Phase 2 ⑥).
        env.sink.emit(
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
            warnings=warnings,
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
        )
    except asyncio.CancelledError as e:
        # Dual cancel semantics: redirect = salvage + return CANCELLED (wave absorbs);
        # stop (整轮) = emit run_cancelled then re-raise so the turn abort propagates.
        cancel_reason = (
            "redirect"
            if e.args and str(e.args[0]) == "redirect"
            else "stop"
        )
        env.sink.emit(
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
        env.sink.emit(run_failed(spec.run_id, agent_id, str(e)))
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
