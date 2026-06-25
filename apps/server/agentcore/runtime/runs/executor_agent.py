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
from agentcore.llm.config import apply_overrides
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.protocol import LLMProvider, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    escalation_raised,
    escalation_required,
    escalation_resolved,
    run_completed,
    run_context,
    run_failed,
    run_started,
)
from agentcore.runtime.facts import record_turn_fact
from agentcore.runtime.interaction import InteractionKind
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.runtime.runs.constants import (
    DEFAULT_CONTRACT_RETRIES,
    ESCALATE_TOOL_NAME,
    MAX_CONTRACT_RETRIES,
    MAX_DELEGATION_DEPTH,
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
    ESCALATION_CONCURRENCY_CAP,
    DelegateFactory,
)
from agentcore.runtime.runs.executor_shared import (
    _is_hard_failure,
    _priced_failure,
    _react_and_capture,
    _registry_with,
    _retry_message,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.serialize import (
    escalations_from_transcript,
    files_touched_from_transcript,
    run_final_fact,
)
from agentcore.runtime.runs.types import ContextBlock, RunPhase, RunSpec, RunState
from agentcore.runtime.workspace import summarize
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
    escalation_timeout: float = 0.0,
    escalation_armed: bool = False,
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
            question: str, assumption: str, questions: list[dict[str, Any]]
        ) -> EscalationOutcome:
            # Cap: count this conversation's already-parked blocking escalates. The check
            # and the suspend's create() run with no await between them (single loop), so
            # the count can't race (设计 §4.7). Over cap ⇒ degrade (proceed on assumption).
            parked = sum(
                1
                for r in bridge.list_pending(conversation_id)
                if r.kind is InteractionKind.ESCALATION
            )
            if parked >= ESCALATION_CONCURRENCY_CAP:
                logger.info("worker.escalate.cap_degraded", run_id=run_id, parked=parked)
                return EscalationOutcome(status="degraded")
            escalation_id = new_id()
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
                        )
                    ),
                )
            except TimeoutError:
                status, answer = "timeout", ""
            else:
                # The resolve body is {answer} or {use_assumption}; 按假设继续 == an early
                # timeout (same disposition, the worker falls back to its assumption).
                if isinstance(result, dict) and result.get("use_assumption"):
                    status, answer = "timeout", ""
                elif isinstance(result, dict):
                    status, answer = "resolved", str(result.get("answer") or "").strip()
                else:
                    status, answer = "resolved", str(result or "").strip()
            resolutions[question] = {"status": status, "answer": answer}
            sink.emit(
                escalation_resolved(
                    run_id,
                    agent_id,
                    escalation_id=escalation_id,
                    status=status,
                    answer=answer,
                )
            )
            return EscalationOutcome(status=status, answer=answer if status == "resolved" else None)

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
            )
        )
        start = time.monotonic()
        contract = spec.policy.contract
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
        # 阻塞式求决策: this worker's blocking-escalate resolutions, keyed by question, so the
        # transcript harvest below can fold the user's answer / timeout disposition into
        # ``RunState.escalations`` for CEO synthesis — driven by the structured channel below,
        # NOT by re-parsing the tool result prose (防补丁绊线, 设计 §4.7). A worker is
        # sequential, so escalates land here in call order, one at a time.
        resolutions: dict[str, dict[str, Any]] = {}
        try:
            profile = apply_overrides(
                profiles.agent(spec.model_preference),
                thinking=spec.thinking,
                reasoning_effort=spec.reasoning_effort,
            )
            # 真·多模型辩手：显式 model 覆写只换 profile 的模型名（保留该档的温度/预算等），
            # 再经 llm（回合级 ProviderRouter）按 ``provider/model`` 前缀路由到对应厂商。空
            # （所有普通 worker）= 用 tier 解析出的模型，行为逐字不变。
            if spec.model:
                profile = replace(profile, model=spec.model)
            priced_model = profile.model
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
                on_escalate=lambda question, assumption, blocking, _rid=spec.run_id, _aid=agent_id: (  # noqa: E501
                    sink.emit(
                        escalation_raised(
                            _rid,
                            _aid,
                            question=question,
                            assumption=assumption,
                            blocking=blocking,
                        )
                    )
                ),
                # 阻塞式求决策: the suspend-for-the-user channel for escalate(blocking=true).
                # None when no bridge (CEO / tests) → escalate stays non-blocking.
                escalation=_escalation_channel(spec.run_id, agent_id, resolutions),
            )
            # 阶段2 嵌套子任务: hand this worker its own delegate tool only when it
            # opted in and is still above the depth cap — then it leads a sub-team
            # (one extra level) and is told so via the captain identity. Otherwise
            # it is a leaf worker on the shared registry with no delegate.
            worker_tools = tools
            # spec.tools is None for an unrestricted worker → react_loop offers all
            # team tools (the fail-safe default); a non-empty list restricts to those.
            allowed_tools = spec.tools
            identity = _WORKER_IDENTITY
            if (
                delegate_factory is not None
                and spec.can_delegate
                and spec.depth < MAX_DELEGATION_DEPTH
            ):
                child_delegate = delegate_factory(spec.run_id, spec.depth)
                worker_tools = _registry_with(tools, child_delegate)
                # Unrestricted (None) stays None — the delegate now lives in
                # worker_tools, so "offer all" already includes it. A restricted list
                # must explicitly gain the delegate name to keep it callable.
                allowed_tools = (
                    None if spec.tools is None else [*spec.tools, child_delegate.schema.name]
                )
                identity = _WORKER_CAPTAIN_IDENTITY
            # escalate is a worker's always-available upward channel — a safety primitive,
            # not a capability the CEO restricts away. An unrestricted worker (None) is
            # already offered it; a least-privilege worker (non-empty allow-list) must
            # keep it explicitly, so it can still flag a blocker instead of guessing.
            if allowed_tools is not None and ESCALATE_TOOL_NAME not in allowed_tools:
                allowed_tools = [*allowed_tools, ESCALATE_TOOL_NAME]
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
            messages = _build_messages(
                plan,
                spec,
                completed,
                system_prompt,
                user_message,
                contract,
                identity=identity,
                index_paths=index_paths,
                blocks_sink=received_blocks,
            )
            # 上下文传递可视化: emit the received context right after assembly (before the
            # LLM react loop) so the frontend's run detail lights up its「收到的上下文」as
            # soon as the worker starts thinking. Bodies capped + journaled (see run_context).
            sink.emit(run_context(spec.run_id, agent_id, _context_block_payloads(received_blocks)))
            attempts = 1 + min(DEFAULT_CONTRACT_RETRIES, MAX_CONTRACT_RETRIES)
            for attempt in range(attempts):
                content, reasoning, round_usage, round_rounds = await _react_and_capture(
                    messages,
                    llm=llm,
                    tools=worker_tools,
                    sink=sink,
                    tool_ctx=tool_ctx,
                    profile=profile,
                    allowed_tools=allowed_tools,
                    run_id=spec.run_id,
                    agent_id=agent_id,
                    citation_sink=worker_citations,
                    approval_gate=approval_gate,
                    usage_sink=inflight,
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
                    contract,
                    files_written=len(files_touched_from_transcript(messages)),
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
            cost = asdict(calculate_cost(profile.model, run_usage))
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
            if not verdict.ok and _is_hard_failure(content, contract):
                reason = "；".join(verdict.failures)
                logger.info("contract.failed", run_id=spec.run_id, failures=verdict.failures)
                sink.emit(run_failed(spec.run_id, agent_id, reason))
                return RunState(
                    phase=RunPhase.FAILED,
                    content=content,
                    reasoning=reasoning,
                    error=reason,
                    escalations=escalations,
                    citations=worker_citations,
                    model=profile.model,
                    duration_ms=duration_ms,
                    rounds=run_rounds,
                    usage=usage,
                    cost=cost,
                    transcript=messages,
                    received_context=received_blocks,
                )
            # The worker's terminal RunState is journaled at the ``execute`` choke point
            # below (run_final_fact — covers COMPLETED *and* FAILED in one place), so resume
            # re-seeds it from facts not the旁路 frame (执行级事件溯源 Phase 2 ⑥).
            sink.emit(
                run_completed(
                    spec.run_id,
                    agent_id,
                    output_summary=summarize(content),
                    duration_ms=duration_ms,
                    # 阶段1 scheduled runs are all delegated workers → member row;
                    # the already-priced usage/cost light up the payroll live.
                    role="member",
                    model=profile.model,
                    usage=usage,
                    cost=cost,
                )
            )
            return RunState(
                phase=RunPhase.COMPLETED,
                content=content,
                reasoning=reasoning,
                warnings=[] if verdict.ok else list(verdict.failures),
                escalations=escalations,
                citations=worker_citations,
                model=profile.model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                files_touched=files_touched_from_transcript(messages),
                usage=usage,
                cost=cost,
                transcript=messages,
                received_context=received_blocks,
            )
        except Exception as e:  # noqa: BLE001 — surface any run failure to UI/state
            duration_ms = int((time.monotonic() - start) * 1000)
            # Bill the rounds that completed before the failure: finished attempts are
            # already in run_usage; an in-flight pass that raised left its spend in
            # ``inflight`` (B-deep 失败计费).
            if inflight:
                run_usage = run_usage + inflight[0]
            logger.error("run.failed", run_id=spec.run_id, error=str(e), exc_info=True)
            sink.emit(run_failed(spec.run_id, agent_id, str(e)))
            return _priced_failure(
                str(e),
                model=priced_model,
                usage=run_usage,
                rounds=run_rounds,
                duration_ms=duration_ms,
            )

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
