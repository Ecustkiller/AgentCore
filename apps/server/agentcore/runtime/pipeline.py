"""ChatPipeline: Prepare -> Execute -> Finalize.

Orchestrates a single user message through the full lifecycle:
  1. Prepare  — build context, resolve prompt/model/tools, load history
  2. Execute  — run ReAct loop, stream events
  3. Finalize — persist assistant message, update conversation
"""

import contextlib
from dataclasses import asdict
from typing import Any, NamedTuple

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect, new_id
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.factory import build_provider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.memory import default_memory_store
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.citations import merge_citations, out_of_range_markers
from agentcore.runtime.costing import aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.engine import join_segments
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    checkpoint_resolved,
    citations_event,
    content_delta,
    error_event,
    message_end,
    message_start,
    plan_review_resolved,
)
from agentcore.runtime.facts import (
    TurnFactLog,
    TurnStartedFact,
    current_fact_log,
    record_turn_fact,
)
from agentcore.runtime.journal import (
    completed_from_journal,
    entries_from_runs,
    plan_from_journal,
    window_from_journal,
)
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
)
from agentcore.runtime.runs import (
    RunKind,
    RunPhase,
    RunSpec,
    build_captain_executor,
    build_captain_resumer,
)
from agentcore.runtime.sessions import (
    SessionLoader,
    SessionSaver,
    default_session_registry,
)
from agentcore.runtime.skills import (
    SkillRegistry,
    build_system_skill_registry,
)
from agentcore.runtime.suspension import (
    AskUserSuspension,
    PlanReviewSuspension,
    SuspensionDeleter,
    SuspensionSaver,
    TurnSuspension,
    captain_transcript,
    turn_history,
)
from agentcore.tools.builtin import (
    build_ceo_tool_registry,
    build_worker_registry,
    file_mutation_tool_names,
)
from agentcore.tools.builtin.ask_user import AskUserTool, ask_user_tool_result
from agentcore.tools.builtin.consult_skill import ConsultSkillTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.revise import ReviseTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


def _assemble_ceo_toolset(
    *,
    llm,
    sink: EventSink,
    base_system_prompt: str,
    user_message: str,
    history: list[dict],
    worker_tools: ToolRegistry,
    base_tool_context: ToolContext,
    profiles: ProfileSet,
    approval_gate: ApprovalGate | None,
    session_store,
    session_saver: SessionSaver | None,
    session_loader: SessionLoader | None,
    conversation_id: str,
    captain_run_id: str,
    checkpoint_enabled: bool,
    message_id: str,
    suspension_saver: SuspensionSaver | None,
    suspension_deleter: SuspensionDeleter | None,
    backend_location: str,
    skill_registry: SkillRegistry,
) -> tuple[DelegateTool, ReviseTool, ToolRegistry]:
    """Wire the CEO coordinator's toolset (delegate + revise + read/retrieval +
    consult_skill + an optional ask_user), shared by a fresh turn and a 2b resume.

    The CEO is a COORDINATOR: it holds only the read/retrieval built-ins plus the
    orchestration primitives, never the mutation tools (those live with workers via
    ``delegate``). ``base_system_prompt`` is the CLEAN prompt handed to delegate /
    revise (reused verbatim by workers — no CEO-chat hints). ``skill_registry`` backs
    the CEO-only ``consult_skill`` tool (提示词瘦身 P2): the advanced-mechanism guidance
    is pulled on demand instead of riding the prompt every turn. ``message_id`` + the
    suspension closures arm durable plan_review pauses (结构化挂起 2b) on the
    top-level delegate. Returns ``(delegate_tool, revise_tool, chat_tools)`` — the
    tools whose accumulated usage/ledger/citations the caller folds into the turn
    totals.
    """
    delegate_tool = DelegateTool(
        llm=llm,
        sink=sink,
        system_prompt=base_system_prompt,
        user_message=user_message,
        history=history,
        tools=worker_tools,
        base_tool_context=base_tool_context,
        captain_run_id=captain_run_id,
        approval_gate=approval_gate,
        profile_set=profiles,
        session_store=session_store,
        session_saver=session_saver,
        conversation_id=conversation_id,
        registry=default_interaction_registry(),
        checkpoint_timeout_seconds=settings.checkpoint_timeout_seconds,
        checkpoint_enabled=checkpoint_enabled,
        message_id=message_id,
        suspension_saver=suspension_saver,
        suspension_deleter=suspension_deleter,
    )
    chat_tools = build_ceo_tool_registry()
    chat_tools.register(delegate_tool)
    revise_gate = approval_gate if backend_location == "local" else None
    revise_tool = ReviseTool(
        llm=llm,
        sink=sink,
        session_store=session_store,
        tools=worker_tools,
        base_tool_context=base_tool_context,
        profile_set=profiles,
        captain_run_id=captain_run_id,
        approval_gate=revise_gate,
        session_saver=session_saver,
        session_loader=session_loader,
    )
    chat_tools.register(revise_tool)
    # consult_skill (提示词瘦身 P2): always wired (not live-user gated) so the CEO can
    # pull any advanced-mechanism guidance on demand; the always-on 能力目录 in the
    # prompt lists the skills whose required tools are actually wired this turn.
    chat_tools.register(ConsultSkillTool(registry=skill_registry))
    if checkpoint_enabled:
        # 结构化挂起 2b: arm the ask_user pause with the SAME durable closures as the
        # delegate plan_review — message_id keys the frame, the turn-level constants
        # (captain_run_id / clean base prompt / user_message) let resume re-wire the
        # CEO toolset, and the saver/deleter persist before the wait + drop after a
        # live resolve. A disconnect mid-ask leaves a frame ``POST .../resume`` maps
        # the answer back onto.
        chat_tools.register(
            AskUserTool(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.checkpoint_timeout_seconds,
                captain_run_id=captain_run_id,
                base_system_prompt=base_system_prompt,
                user_message=user_message,
                message_id=message_id,
                suspension_saver=suspension_saver,
                suspension_deleter=suspension_deleter,
            )
        )
    return delegate_tool, revise_tool, chat_tools


def _build_attachment_context(attachments: list[dict] | None) -> str | None:
    """Render user-referenced files/directories into a system-prompt block.

    Files carry pre-extracted text; directories carry a recursive file listing
    (paths only, no file bodies). Both are truncated client-side. A file with a
    ``workspace_path`` was persisted into the workspace (附件驻留), so the header
    points the agent at that durable path — it can re-read or edit the file with
    the file tools instead of relying only on the inlined (possibly truncated)
    copy. Returns None when there is nothing to inject so the base prompt stays
    unchanged.
    """
    if not attachments:
        return None

    blocks: list[str] = []
    resident = False
    for att in attachments:
        text = (att.get("text") or "").strip()
        if not text:
            continue
        name = att.get("name") or "untitled"
        if att.get("kind") == "dir":
            path = att.get("path") or name
            note = " (partial listing)" if att.get("truncated") else ""
            blocks.append(
                f"--- Directory: {name} ({path}){note} ---\n"
                f"File paths (contents not included):\n{text}"
            )
        else:
            # Prefer the durable in-workspace path so the model can act on the
            # real file; fall back to the original (local) path when un-resident.
            ws_path = att.get("workspace_path")
            path = ws_path or att.get("path") or name
            if ws_path:
                resident = True
            note = " (truncated)" if att.get("truncated") else ""
            blocks.append(f"--- File: {name} ({path}){note} ---\n{text}")

    if not blocks:
        return None

    body = "\n\n".join(blocks)
    resident_note = (
        " Files shown with an in-workspace path have been saved into your "
        "workspace — read or edit them with the file tools by that path rather "
        "than trusting only the (possibly truncated) text below."
        if resident
        else ""
    )
    return (
        "<attached_files>\n"
        "The user attached the following files and directories as context for "
        "this message. Treat them as reference material the user provided; cite "
        "them by name when relevant. Directory entries list file paths only "
        f"(file contents are not included).{resident_note}\n\n"
        f"{body}\n"
        "</attached_files>"
    )


def _build_runs_payload(sink: EventSink, finish: FinishReason) -> dict | None:
    """Assemble the assistant message's ``runs`` payload from the turn's sink.

    Carries two replay artifacts on one field: the multi-agent ``events`` journal
    (team graph) and the single-agent ``process`` timeline (inline 思考+工具面板).
    A turn is one OR the other — the journal is None unless it delegated/checkpointed,
    the process is None unless it was a tool-using single-agent turn — but the
    shared shape keeps one persistence + load path. Returns None when there is
    nothing to replay (a plain chat turn with neither)."""
    journal = sink.execution_journal()
    process = sink.process_timeline()
    if journal is None and process is None:
        return None
    payload: dict[str, Any] = {
        "events": journal or [],
        "finish_reason": finish.value,
    }
    if process:
        payload["process"] = process
    return payload


def _durable_journal_entries(
    fact_log: TurnFactLog, runs: dict[str, Any] | None
) -> list[dict[str, Any]] | None:
    """The §18.3 fact log composed into the turn's durable journal entries (or None).

    The fact log is the single ordered stream (execution facts interleaved with the
    forwarded display facts); the durable journal adds the display-only tail the log
    does not carry — the single-agent ``process`` timeline (a post-hoc display
    aggregate) + the closing ``turn_end`` — both read off the already-built ``runs``
    so the two stay consistent. ``runs.events`` is NOT re-appended: those display
    events already ride the fact log (ungated), and the read-side projection
    (:func:`~agentcore.runtime.journal.runs_from_entries`) re-gates them.

    Gated to ``runs`` non-None — the SAME turns that persisted a journal before — so a
    plain chat turn still writes nothing (storage + None-gate parity); resume / salvage
    / local-relay paths carry no fact log and fall back to the legacy ``runs`` flatten.
    """
    if runs is None:
        return None
    tail = entries_from_runs(
        {"process": runs.get("process"), "finish_reason": runs.get("finish_reason")}
    )
    return fact_log.entries() + tail


async def run_chat_pipeline(
    *,
    conversation_id: str,
    user_message: str,
    history: list[dict],
    sink: EventSink,
    user_id: str,
    backend: WorkspaceBackend,
    attachments: list[dict] | None = None,
    approvals_enabled: bool = True,
    profile_set: ProfileSet | None = None,
    llm_credentials: LLMCredentials | None = None,
    session_saver: SessionSaver | None = None,
    session_loader: SessionLoader | None = None,
    suspension_saver: SuspensionSaver | None = None,
    suspension_deleter: SuspensionDeleter | None = None,
) -> dict:
    """Run the full chat pipeline for a single user message.

    Returns a dict with final_content, usage, and metadata.
    The sink receives all SSE events during execution.

    ``approvals_enabled`` gates GRANTABLE tools behind the user's consent (the
    default interactive path). It is set False for an autonomous local→云 handoff
    job (双模式工作区 P2e / e2): that run has no live client to answer prompts and
    operates on an isolated server sandbox, so — like cloud-mode workers — it needs
    no gate; leaving it on would deadlock every file/exec tool on a timeout-deny.

    ``profile_set`` carries the turn's resolved 质量档 (经济/高质量/custom): which
    model each scenario (chat/agent.strong/...) runs this turn, resolved by the
    caller from the conversation/user/operator default (llm/modes.py). ``None``
    (e.g. the autonomous handoff job) falls back to the economy base set.

    ``llm_credentials`` are the turn's resolved BYOK key + endpoint (config.
    billing_mode); the caller resolves them once (route preflight) and threads them
    here so the whole turn runs on the user's own DeepSeek quota. ``None`` falls
    back to the global server key (platform mode).
    """
    profiles = profile_set or default_profile_set()
    message_id = new_id()
    # The CEO captain is the turn's root Run node (kind=captain): it owns the reply
    # voice and may delegate. Its run id parents every delegated member's ledger row
    # and labels the captain cost row; agent_id == run_id (阶段1 convention). When
    # the CEO delegates, this id is declared as the graph's CAPTAIN 汇聚点 the
    # workers hang under (see DelegateTool._plan_event).
    captain_run_id = new_id()

    # 执行级事件溯源 (§18.3): the turn's single ordered fact log. Bound to the ambient
    # contextvar BEFORE any sink.emit / captain run so the engine's execution facts
    # (round_boundary / llm_call / note / message_final) AND the sink's display facts
    # (run_*/tool_use_*/interaction) accumulate here in ONE order — copied into each
    # delegated worker's task, so the whole team writes to this log. Reset in finally.
    fact_log = TurnFactLog()
    fact_log_token = current_fact_log.set(fact_log)
    # 执行级事件溯源 Phase 2 ⑤: publish this turn's history so a suspending face captures it
    # into the durable frame — the resume window splices it ahead of the journal-folded
    # rounds (the journal stores only history's LENGTH). Reset in finally.
    history_token = turn_history.set(history)

    try:
        # --- Phase 1: Prepare ---
        memory_markdown = await default_memory_store().load(user_id)
        # Clean, stable base (base + date + memory): NO attachments, NO CEO hints.
        # This is the cacheable prefix shared by the CEO and reused verbatim by
        # workers. The (per-turn, variable) attachment block is appended LAST below —
        # after the stable CEO hint stack — so a turn carrying attached files does not
        # bust DeepSeek's prefix cache for the hints (缓存友好: 易变内容置于稳定前缀之后).
        system_prompt = assemble_system_prompt(memory_markdown=memory_markdown)
        attachment_context = _build_attachment_context(attachments)
        # Workers hold no CEO hints, so their base is the clean base + the same
        # attachment block appended at the end — byte-identical to the old single-call
        # assembly (assemble joins with "\n"), so the delegated team still sees the
        # user's files while the worker's own stable prefix (base) stays cacheable.
        worker_base_prompt = (
            f"{system_prompt}\n{attachment_context}"
            if attachment_context
            else system_prompt
        )
        worker_tools = build_worker_registry()
        # System skills (提示词瘦身 P2): the advanced-mechanism guidance the CEO pulls
        # on demand via consult_skill. Built once per turn; backs the tool AND the
        # always-on 能力目录 rendered into the CEO prompt below.
        skill_registry = build_system_skill_registry()
        llm = build_provider(llm_credentials)

        # The workspace backend is resolved per conversation by the caller
        # (folder space vs. its own conversation space) and injected here. The
        # engine and tools never see a Path — they only touch ``context.backend``.
        base_tool_context = ToolContext(
            execution_id=new_id(),
            run_id=new_id(),
            agent_id="default",
            backend=backend,
            user_id=user_id,
            conversation_id=conversation_id,
        )

        # --- Phase 2: Assemble the CEO chat agent's toolset (coordinator) ---
        # The CEO owns the conversation and replies directly, but it is a
        # COORDINATOR: it carries only the read / retrieval built-ins
        # (``build_ceo_tool_registry`` — web_search/read_url/file_read/file_list/
        # grep) plus the on-demand orchestration primitive ``delegate``. It holds
        # NONE of the production / mutation tools (file_write/str_replace/
        # file_delete/file_move/code_execute); any work that produces or changes an
        # artifact is handed to a worker. There is no mandatory pre-turn
        # orchestrator pass — the CEO itself decides when/at what granularity to
        # delegate. ``delegate`` is NON-terminal: workers' products return to the
        # CEO's own ReAct loop, which writes a short user-facing overview in its own
        # voice (D3 / 决策①: per-worker detail is shown separately in the UI).
        # Workers get the FULL ``worker_tools`` (no nested delegate tool), so a
        # worker can do the actual writing/editing/running but can never recursively
        # delegate another team.
        # Approval gate (one per turn so an "allow for the rest of this turn" grant
        # is scoped to this message and does not leak across turns). It is wired into
        # the CEO's loop, but with the coordinator boundary the CEO holds no
        # GRANTABLE tools — so approvals now bite at the WORKER layer: the SAME
        # instance is handed to the delegate tool, which forwards it to workers ONLY
        # in local mode (双模式工作区 P2d 执行门) — so a delegated worker can't run
        # code / mutate files on the user's real machine without consent, while a
        # cloud team stays un-gated (isolated sandbox).
        approval_gate = (
            ApprovalGate(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
                file_op_tools=file_mutation_tool_names(),
            )
            if (settings.approval_gate_enabled and approvals_enabled)
            else None
        )
        # The conversation's live roster (留人, 乙 热修): delegate registers each
        # COMPLETED worker here as a recoverable RunSession, and revise recalls one to
        # continue on its own draft. Conversation-scoped (P2) — fetched from the
        # process-wide registry so it SURVIVES across turns ("改下刚才那个" works next
        # turn); bounded by TTL + count + byte caps, idle conversations reaped. An
        # expiry / miss falls back to 甲 (re-delegate). Cross-process persistence: P3.
        session_store = default_session_registry().get_or_create(conversation_id)
        # Structured DAG checkpoints (结构化挂起 2a) share the SAME gate as ask_user
        # (a live interactive user): an autonomous handoff job has no client to
        # answer, so a checkpoint there would only ever time out. Computed here —
        # before the delegate tool — because delegate consumes it too (it suspends
        # the WaveScheduler at a wave boundary when a step is marked checkpoint_after).
        checkpoint_enabled = settings.checkpoint_gate_enabled and approvals_enabled
        # The delegate tool gets the worker base prompt — the CLEAN base (no CEO chat
        # hints, reused verbatim by workers in runs/executor.py — they must not be told
        # about a delegate tool they do not hold) plus this turn's attachment block.
        # message_id + the suspension closures arm durable plan_review pauses (结构化
        # 挂起 2b) on the top-level delegate.
        delegate_tool, revise_tool, chat_tools = _assemble_ceo_toolset(
            llm=llm,
            sink=sink,
            base_system_prompt=worker_base_prompt,
            user_message=user_message,
            history=history,
            worker_tools=worker_tools,
            base_tool_context=base_tool_context,
            profiles=profiles,
            approval_gate=approval_gate,
            session_store=session_store,
            session_saver=session_saver,
            session_loader=session_loader,
            conversation_id=conversation_id,
            captain_run_id=captain_run_id,
            checkpoint_enabled=checkpoint_enabled,
            message_id=message_id,
            suspension_saver=suspension_saver,
            suspension_deleter=suspension_deleter,
            backend_location=backend.location,
            skill_registry=skill_registry,
        )

        # The entry chat agent gets the SLIM CEO core + the always-on 能力目录 (提示词
        # 瘦身 P2) + inline citation guidance. The directory lists only the skills whose
        # required tools are actually wired this turn (derived from the assembled CEO
        # toolset), so it never advertises a capability the CEO does not hold (e.g.
        # asking_the_user appears only on the live-user path, when ask_user is wired)
        # — the same invariant the old per-hint gating enforced. The advanced「怎么做」
        # detail no longer rides every turn; the CEO pulls it via consult_skill.
        ceo_tool_names = {schema.name for schema in chat_tools.list_all()}
        chat_system_prompt = compose_ceo_chat_prompt(
            system_prompt,
            skill_registry=skill_registry,
            ceo_tool_names=ceo_tool_names,
        )
        # Attachments LAST — after the whole stable hint stack — so the CEO prefix
        # (base + hints) stays byte-identical across turns and rides the prefix cache
        # even on a turn that carries (variable) attached files.
        if attachment_context:
            chat_system_prompt = f"{chat_system_prompt}\n{attachment_context}"

        # --- Phase 3: Execute ---
        sink.emit(message_start(message_id, conversation_id=conversation_id))

        profile = profiles.get("chat")

        # 执行级事件溯源 (§18.3): the turn's HEAD fact — the verbatim CEO system prompt
        # (dynamic: date / skills / attachments, so captured not re-rendered), the user
        # message, the model profile, and how many prior messages were folded in. This
        # is the window fold's anchor; recorded before the captain runs so it is the
        # log's first fact (message_start is display-only, not journaled).
        record_turn_fact(
            TurnStartedFact(
                system_prompt=chat_system_prompt,
                user_message=user_message,
                model_profile=profile.model,
                history_len=len(history),
            ).to_fact()
        )

        # Web sources the chat agent consults this turn (web_search / read_url),
        # aggregated + de-duped by the loop for source cards + persistence.
        citations: list[dict] = []

        # The CEO captain runs through the run executor as the turn's ROOT Run node
        # — the same react_loop assembly the workers use — instead of the pipeline
        # driving react_loop itself. It owns the reply voice (content/reasoning
        # stream to the chat bubble), runs the chat profile, holds the
        # read/retrieval tools + delegate, and writes the user-facing answer,
        # delegating mid-loop when a team is needed. When it delegates, its run id
        # is the graph's CAPTAIN 汇聚点 the workers hang under.
        captain_spec = RunSpec(
            run_id=captain_run_id,
            agent_id=captain_run_id,
            agent_name="CEO",
            kind=RunKind.CAPTAIN,
            task=user_message,
            role="CEO",
            depth=0,
            parent_run_id=None,
        )
        run_captain = build_captain_executor(
            llm=llm,
            tools=chat_tools,
            sink=sink,
            base_tool_context=base_tool_context,
            chat_system_prompt=chat_system_prompt,
            history=history,
            user_message=user_message,
            profile=profile,
            citation_sink=citations,
            approval_gate=approval_gate,
        )
        captain_state = await run_captain(captain_spec)

        if captain_state.phase is RunPhase.FAILED:
            err = captain_state.error or "captain run failed"
            sink.emit(error_event("PIPELINE_ERROR", err))
            sink.emit(message_end(FinishReason.ERROR))
            # A captain that died mid-loop still burned tokens (B-deep 失败计费): the
            # executor priced them onto captain_state, so carry the captain ledger row
            # back even on error — _persist_turn_result writes cost_runs independently
            # of whether any assistant text landed. Skip when nothing metered (no
            # usage → no row), so a pre-LLM crash stays free.
            cost_runs = (
                [asdict(captain_run_cost_from_state(captain_run_id, captain_state))]
                if captain_state.usage
                else []
            )
            return {
                "message_id": message_id,
                "content": "",
                "error": err,
                "finish_reason": FinishReason.ERROR,
                "cost_runs": cost_runs,
            }

        final_content = captain_state.content
        final_reasoning = captain_state.reasoning
        rounds = captain_state.rounds

        # Turn usage = the captain run's own spend (priced once in the executor onto
        # captain_state.cost/.usage) + the delegated workers' usage + every 定向唤回
        # (revise) continuation's usage, both accumulated on their tool instances
        # across the turn. ``delegate`` / ``revise`` are non-terminal, so the captain
        # loop never metered their tokens; the cache split rides along so the folded
        # total stays priceable.
        turn_usage = (
            TokenUsage.from_usage_dict(captain_state.usage)
            + TokenUsage.from_usage_dict(delegate_tool.usage)
            + TokenUsage.from_usage_dict(revise_tool.usage)
        )
        finish = captain_state.finish_override or (
            FinishReason.END_TURN
            if rounds < profile.max_rounds
            else FinishReason.MAX_ROUNDS
        )

        # Per-run cost ledger for 落账 (决策②: captain root + one row per member).
        # The captain was priced once in the executor (captain_state.cost); read it
        # into the captain ledger row (no re-price). Members were priced onto their
        # RunState in the executor and collected on the delegate tool. Built before
        # message_end so the turn total can ride on it (回合总账实时); the service
        # then attaches the user/conversation/message envelope and persists the
        # rows (warning-only on failure).
        captain_cost = captain_run_cost_from_state(captain_run_id, captain_state)
        cost_runs = [
            asdict(captain_cost),
            *(asdict(r) for r in delegate_tool.run_ledger),
            # Each 定向唤回 (revise) continuation is its own member run row, parented
            # to the original worker so the version chain is reconstructable (决策②).
            *(asdict(r) for r in revise_tool.run_ledger),
        ]
        turn_cost = aggregate_cost(cost_runs)

        # Fold the delegated workers' web sources into the turn's shared card
        # (deduped/capped against the CEO's own searches). The CEO collected its
        # sources live during the loop (numbered + cited inline); workers collected
        # theirs un-numbered, so appending them here keeps the CEO's [n] stable and
        # still surfaces the WHOLE team's research to the user. Mirrors how worker
        # usage/cost are folded back off the delegate tool instance above.
        merge_citations(citations, delegate_tool.citations)
        merge_citations(citations, revise_tool.citations)

        # 引用越界观测：模型偶尔写出指向「不存在来源卡」的 [n]（数错或想指上一轮的号）。
        # 客户端会把这类越界角标降级成纯文本，所以正文不动——只记一条 warning，让这种
        # 误引率可被度量（logs/dev.jsonl，conversation_id 由 contextvars 自动带上）。
        stray_markers = out_of_range_markers(final_content, len(citations))
        if stray_markers:
            logger.warning(
                "citations.out_of_range",
                message_id=message_id,
                markers=stray_markers,
                citation_count=len(citations),
            )

        # Emit before message_end so the client attaches source cards to the
        # assistant message while it is still the live streaming bubble.
        if citations:
            sink.emit(citations_event(citations))

        sink.emit(
            message_end(
                finish,
                input_tokens=turn_usage.input_tokens,
                output_tokens=turn_usage.output_tokens,
                reasoning_tokens=turn_usage.reasoning_tokens,
                cache_hit_tokens=turn_usage.cache_hit_tokens,
                cache_miss_tokens=turn_usage.cache_miss_tokens,
                rounds=rounds,
                cost=turn_cost,
            )
        )

        # Turn replay payload: the multi-agent team-graph journal OR the
        # single-agent 思考+工具 process timeline (or None for a plain turn).
        # Mirrors how citations are carried back on the result.
        runs = _build_runs_payload(sink, finish)

        return {
            "message_id": message_id,
            "content": final_content,
            "reasoning_content": final_reasoning,
            "input_tokens": turn_usage.input_tokens,
            "output_tokens": turn_usage.output_tokens,
            "reasoning_tokens": turn_usage.reasoning_tokens,
            "rounds": rounds,
            "finish_reason": finish,
            "citations": citations,
            "runs": runs,
            "cost_runs": cost_runs,
            # 执行级事件溯源 (§18.3): the durable journal source — the turn's single
            # ordered fact log (engine execution facts interleaved with the forwarded
            # display facts) + the process / turn_end tail. The persistence tail stores
            # this verbatim and projects it back (gated) for display. Gated to the SAME
            # turns that persisted before (``runs`` non-None): a plain chat turn keeps
            # writing no journal (storage + None-gate parity); when it surfaced a graph
            # or a single-agent process, the journal is now lossless.
            "journal_entries": _durable_journal_entries(fact_log, runs),
        }

    except Exception as e:
        logger.error("pipeline.error", error=str(e), exc_info=True)
        sink.emit(error_event("PIPELINE_ERROR", str(e)))
        sink.emit(message_end(FinishReason.ERROR))
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "finish_reason": FinishReason.ERROR,
        }
    finally:
        current_fact_log.reset(fact_log_token)
        turn_history.reset(history_token)
        sink.close()
        with contextlib.suppress(Exception):
            await llm.close()


def _append_resumed_tool_results(
    messages: list[LLMMessage], tool_call_id: str, output: str
) -> None:
    """Close the suspended tool-call in the rebuilt CEO transcript (结构化挂起 2b).

    The transcript ends with the assistant message that issued the suspended call
    (``delegate`` for plan_review, ``ask_user`` for ask_user — the pause happened
    inside it). Append the settled result as that call's tool result so the loop
    continues from a valid assistant-tool_call → tool-result pair. Any SIBLING
    tool_calls in the same assistant turn (a rare concurrent call) get a placeholder
    result, since every tool_call MUST have a matching result or the next request
    400s — their work wasn't captured (the pause unwound only the suspended call).
    """
    last = messages[-1] if messages else None
    if last is None or last.role != "assistant" or not last.tool_calls:
        messages.append(
            LLMMessage(role="tool", content=output, tool_call_id=tool_call_id)
        )
        return
    target = tool_call_id or (last.tool_calls[0].id if last.tool_calls else "")
    for tc in last.tool_calls:
        if tc.id == target:
            messages.append(
                LLMMessage(role="tool", content=output, tool_call_id=tc.id)
            )
        else:
            messages.append(
                LLMMessage(
                    role="tool",
                    content="（该并行工具调用在本回合暂停时未保留结果，已跳过。）",
                    tool_call_id=tc.id,
                )
            )


class _SettledSuspension(NamedTuple):
    """The outcome of applying a resume decision to a paused frame (结构化挂起 2b).

    ``output`` is the suspended tool-call's result text, fed back into the rebuilt
    CEO transcript. ``terminal_text`` is set only when the answer ended the turn
    in-band (ask_user ``stop``) — its closing note IS the reply, so resume finishes
    on it WITHOUT another CEO round (mirroring the engine's terminal-effect branch);
    ``None`` means run the CEO loop to its reply (plan_review always; ask_user
    continue / adjust / timeout).
    """

    output: str
    terminal_text: str | None


async def _settle_resumed_suspension(
    suspension: TurnSuspension,
    *,
    decision: CheckpointDecision,
    note: str,
    selected: list[str],
    sink: EventSink,
    delegate_tool: DelegateTool,
    execution_id: str,
) -> _SettledSuspension:
    """Apply the user's resume decision to the paused frame, by kind (结构化挂起 2b).

    plan_review: emit the resolution, then ``delegate.resume_plan`` drives the
    remaining tail (continue / adjust-steer / stop-skip) and returns the workers'
    product — always fed back to the CEO loop (which writes the overview).

    ask_user: emit the resolution, then map the answer to the ``ask_user`` tool
    result via the shared :func:`ask_user_tool_result`. A ``stop`` yields a terminal
    result whose closing note ends the turn directly (no CEO round); the picks are
    validated against the offered options just like the live path.
    """
    if isinstance(suspension, AskUserSuspension):
        response = CheckpointResponse(decision=decision, note=note, selected=list(selected))
        # Drop any pick that was not on some question's menu (same guard as the live
        # tool; the desktop composes its answer into ``note`` and sends no picks).
        allowed = {o for q in suspension.questions for o in q.get("options", [])}
        response.selected = [s for s in response.selected if s in allowed]
        sink.emit(
            checkpoint_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=response.decision.value,
                note=response.note,
                selected=response.selected,
            )
        )
        result = ask_user_tool_result(response)
        terminal = result.final_text if result.effect is ToolEffect.INTERACT else None
        return _SettledSuspension(result.output, terminal)

    if isinstance(suspension, PlanReviewSuspension):
        sink.emit(
            plan_review_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=decision.value,
                note=note,
            )
        )
        # Re-seed finished workers from the §18.3 journal run-final facts (执行级事件溯源
        # Phase 2 ⑥ — `completed_from_journal` == the dropped `frame.completed`, gated by
        # the conformance golden), so the resumed plan bills the whole graph once without
        # the旁路 blob. Falls back to the in-memory `completed` for a same-process resume
        # (tests) whose journal was not hydrated; a claimed frame always carries the facts
        # (else `_resumed_captain_window` already raised on the empty journal upstream).
        seed_completed = (
            completed_from_journal(suspension.journal_entries) or suspension.completed
        )
        # Rebuild the DAG from the journal's plan_snapshot fact (执行级事件溯源 Phase 2 —
        # `plan_from_journal` == the dropped `frame.plan`, gated by the conformance golden),
        # so the resumed drive re-mints nothing and its run_ids match `seed_completed`. Same
        # fallback posture as the seed: the in-memory `plan` carrier covers a same-process
        # resume (tests) whose journal was not bound; a claimed frame always carries the fact.
        plan = plan_from_journal(suspension.journal_entries) or suspension.plan
        delegate_result = await delegate_tool.resume_plan(
            plan,
            seed_completed,
            decision=decision,
            note=note,
            checkpoint_run_ids=suspension.checkpoint_run_ids,
            execution_id=execution_id,
        )
        return _SettledSuspension(delegate_result.output, None)

    raise ValueError(f"unknown suspension kind: {suspension.kind!r}")


def _resumed_captain_window(
    suspension: TurnSuspension, history: list[dict] | None
) -> list[LLMMessage]:
    """Rebuild the resumed CEO window from the §18.3 turn journal (Phase 2 ④/⑤).

    The captain transcript at pause is a PROJECTION of the journal, not a stored blob:
    fold ``suspension.journal_entries`` (the fact stream re-hydrated by ``claim_paused_turn``
    from ``turn_journal``, or carried in the Sidecar's local frame) back into the LLM
    window via :func:`window_from_journal`, splicing the reloaded conversation ``history``
    between the captured system prompt and the user message (the journal stores only its
    length — history is itself a projection of earlier turns, supplied by the caller exactly
    as a fresh send builds it: the cloud reloads it from the message DB, the Sidecar from
    its local frame record). The captain run is inferred from the journal's first
    ``role="captain"`` round_boundary, so it does not depend on the frame's ``captain_run_id``.

    ``suspension.transcript`` is NO LONGER serialized (Phase 2 ⑤) — it survives only as an
    in-memory carrier on a same-process resume (tests), so a non-empty one is used (with a
    warning) but a claimed frame's is empty. When BOTH the journal and the in-memory
    transcript are empty the pause is unrecoverable (its best-effort ``turn_journal`` write
    was lost): fail LOUD rather than resume on a silently empty window.
    """
    history_msgs = (
        [LLMMessage(role=h["role"], content=h["content"]) for h in history]
        if history
        else None
    )
    window = window_from_journal(suspension.journal_entries, history=history_msgs)
    if window:
        return window
    if suspension.transcript:
        logger.warning(
            "resume.window_from_frame_fallback",
            message_id=suspension.message_id,
            reason="journal_unavailable_inmemory_transcript",
            frame_transcript_len=len(suspension.transcript),
        )
        return list(suspension.transcript)
    raise RuntimeError(
        "resume: cannot rebuild the CEO window — no journal_entries to fold and no "
        "in-memory transcript (the pause's turn_journal write was lost); "
        f"message_id={suspension.message_id}"
    )


async def resume_chat_pipeline(
    *,
    suspension: TurnSuspension,
    decision: CheckpointDecision,
    note: str,
    selected: list[str] | None = None,
    sink: EventSink,
    backend: WorkspaceBackend,
    history: list[dict] | None = None,
    llm_credentials: LLMCredentials | None = None,
    profile_set: ProfileSet | None = None,
    session_saver: SessionSaver | None = None,
    session_loader: SessionLoader | None = None,
    suspension_saver: SuspensionSaver | None = None,
    suspension_deleter: SuspensionDeleter | None = None,
) -> dict:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume).

    Rebuilds the turn from the §18.3 turn journal and finishes it: re-wire the CEO
    toolset, seed the display journal with the pre-pause graph, **rebuild the CEO window
    by folding the journal facts** (:func:`_resumed_captain_window` — the captain
    transcript is a projection of the journal, no longer read from ``frame.transcript``,
    执行级事件溯源 Phase 2 ④), apply the user's decision to the paused frame by kind
    (:func:`_settle_resumed_suspension`), feed the settled result back as the suspended
    tool result, and — unless the answer ended the turn in-band (ask_user ``stop``) — run
    the CEO loop on the rebuilt window to its reply. ``history`` is the reloaded prior
    context (the caller passes ``load_chat_context(...)[:-1]`` exactly as a fresh send),
    spliced into the window head since the journal stores only its length. The whole turn
    is billed ONCE here, under the ORIGINAL ``message_id`` so the assistant row + ledger
    reuse it. A downstream checkpoint can pause again — the same hooks re-persist a fresh
    frame, so resume is fully re-entrant. ``selected`` carries the user's option picks
    (ask_user only). Returns the same result shape as :func:`run_chat_pipeline`.
    """
    profiles = profile_set or default_profile_set()
    message_id = suspension.message_id
    conversation_id = suspension.conversation_id
    captain_run_id = suspension.captain_run_id or new_id()
    llm = build_provider(llm_credentials)
    # Republish history so a re-pause DURING the settle (a downstream checkpoint while
    # resume_plan runs) captures it into the fresh frame — symmetric with the live turn
    # (Phase 2 ⑤). Reset in finally.
    history_token = turn_history.set(history or [])
    try:
        worker_tools = build_worker_registry()
        # Same system-skill registry as a fresh turn so the resumed CEO loop can
        # still consult_skill (提示词瘦身 P2). The CEO prompt itself is replayed from
        # the stored transcript (already slim + 能力目录), so no directory re-render.
        skill_registry = build_system_skill_registry()
        base_tool_context = ToolContext(
            execution_id=new_id(),
            run_id=new_id(),
            agent_id="default",
            backend=backend,
            user_id=suspension.user_id,
            conversation_id=conversation_id,
        )
        approval_gate = (
            ApprovalGate(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
                file_op_tools=file_mutation_tool_names(),
            )
            if settings.approval_gate_enabled
            else None
        )
        session_store = default_session_registry().get_or_create(conversation_id)
        checkpoint_enabled = settings.checkpoint_gate_enabled
        delegate_tool, revise_tool, chat_tools = _assemble_ceo_toolset(
            llm=llm,
            sink=sink,
            base_system_prompt=suspension.base_system_prompt,
            user_message=suspension.user_message,
            history=[],
            worker_tools=worker_tools,
            base_tool_context=base_tool_context,
            profiles=profiles,
            approval_gate=approval_gate,
            session_store=session_store,
            session_saver=session_saver,
            session_loader=session_loader,
            conversation_id=conversation_id,
            captain_run_id=captain_run_id,
            checkpoint_enabled=checkpoint_enabled,
            message_id=message_id,
            suspension_saver=suspension_saver,
            suspension_deleter=suspension_deleter,
            backend_location=backend.location,
            skill_registry=skill_registry,
        )

        sink.emit(message_start(message_id, conversation_id=conversation_id))
        # Continue the pre-pause exchange: seed the journal so the persisted turn
        # journal (projected as the message's runs) replays the whole graph +
        # checkpoint, then settle the pause.
        sink.seed_journal(suspension.journal)

        # Rebuild the CEO window by FOLDING the turn journal (Phase 2 ④): the captain
        # transcript at pause is a projection of the §18.3 facts, not a stored blob —
        # window_from_journal(journal_entries) + the reloaded history reconstructs the
        # exact messages the CEO suspended on (the conformance golden gates this ==).
        transcript = _resumed_captain_window(suspension, history)

        # Publish the pre-pause CEO transcript so a re-pause DURING the settle (a
        # second downstream checkpoint while resume_plan runs) captures the same
        # transcript the CEO is still suspended on — symmetric with the original pause.
        token = captain_transcript.set(transcript)
        try:
            settled = await _settle_resumed_suspension(
                suspension,
                decision=decision,
                note=note,
                selected=selected or [],
                sink=sink,
                delegate_tool=delegate_tool,
                execution_id=base_tool_context.execution_id,
            )
        finally:
            captain_transcript.reset(token)

        # Rebuild the CEO transcript: the folded window (ending at the assistant
        # suspended call) + that call's settled tool result.
        messages = list(transcript)
        # Carry the CEO's pre-pause reply forward: the resumed loop below starts from a
        # blank content, so without this the persisted content (and the next turn's LLM
        # history) would lose everything written before the pause — parity with live.
        pre_pause_content = _pre_pause_content(transcript)
        _append_resumed_tool_results(messages, suspension.tool_call_id, settled.output)

        # ask_user stop: the closing note IS the reply (terminal effect) — finish
        # without another CEO round, mirroring the engine's terminal-effect branch.
        if settled.terminal_text is not None:
            if settled.terminal_text:
                sink.emit(content_delta(settled.terminal_text))
            return _finish_terminal_resume(
                message_id=message_id,
                pre_pause_content=pre_pause_content,
                closing=settled.terminal_text,
                sink=sink,
            )

        # Otherwise run the CEO loop to its reply (it may delegate / ask again).
        profile = profiles.get("chat")
        citations: list[dict] = []
        captain_spec = RunSpec(
            run_id=captain_run_id,
            agent_id=captain_run_id,
            agent_name="CEO",
            kind=RunKind.CAPTAIN,
            task=suspension.user_message,
            role="CEO",
            depth=0,
            parent_run_id=None,
        )
        run_captain = build_captain_resumer(
            llm=llm,
            tools=chat_tools,
            sink=sink,
            base_tool_context=base_tool_context,
            profile=profile,
            citation_sink=citations,
            approval_gate=approval_gate,
        )
        captain_state = await run_captain(captain_spec, messages)

        if captain_state.phase is RunPhase.FAILED:
            err = captain_state.error or "captain resume failed"
            sink.emit(error_event("PIPELINE_ERROR", err))
            sink.emit(message_end(FinishReason.ERROR))
            # Bill the resumed captain's partial spend on a hard failure (B-deep 失败
            # 计费), same as the fresh-turn path: priced onto captain_state, persisted
            # by _persist_turn_result even without an assistant reply. No usage → no row.
            cost_runs = (
                [asdict(captain_run_cost_from_state(captain_run_id, captain_state))]
                if captain_state.usage
                else []
            )
            return {
                "message_id": message_id,
                "content": "",
                "error": err,
                "finish_reason": FinishReason.ERROR,
                "cost_runs": cost_runs,
            }

        return _finish_resume_turn(
            message_id=message_id,
            captain_run_id=captain_run_id,
            captain_state=captain_state,
            pre_pause_content=pre_pause_content,
            delegate_tool=delegate_tool,
            revise_tool=revise_tool,
            profile=profile,
            citations=citations,
            sink=sink,
        )

    except Exception as e:
        logger.error("pipeline.resume_error", error=str(e), exc_info=True)
        sink.emit(error_event("PIPELINE_ERROR", str(e)))
        sink.emit(message_end(FinishReason.ERROR))
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "finish_reason": FinishReason.ERROR,
        }
    finally:
        turn_history.reset(history_token)
        sink.close()
        with contextlib.suppress(Exception):
            await llm.close()


def _pre_pause_content(transcript: list[LLMMessage]) -> str:
    """The CEO's pre-pause reply text for a resumed turn (结构化挂起 2b parity).

    The durable frame's ``transcript`` ends with THIS turn's assistant rounds (the last
    carries the suspended tool_call). A fresh-process resume re-runs the CEO loop from a
    blank ``final_content``, so without this the persisted ``content`` would keep ONLY
    the post-resume text — losing whatever the CEO wrote before it paused (e.g. a
    mid-task overview) and silently shrinking the next turn's LLM history. Rebuild it the
    way the live loop would: join this turn's assistant contents (everything after the
    last user message) as paragraphs. Prior turns (history before that user message) are
    their own messages and are excluded.
    """
    start = 0
    for i in range(len(transcript) - 1, -1, -1):
        if transcript[i].role == "user":
            start = i + 1
            break
    acc = ""
    for msg in transcript[start:]:
        if msg.role == "assistant" and msg.content:
            acc = join_segments(acc, msg.content)
    return acc


def _finish_resume_turn(
    *,
    message_id: str,
    captain_run_id: str,
    captain_state,
    pre_pause_content: str,
    delegate_tool: DelegateTool,
    revise_tool: ReviseTool,
    profile,
    citations: list[dict],
    sink: EventSink,
) -> dict:
    """Bill + close a resumed turn whose CEO loop ran (plan_review / ask_user continue).

    The whole turn bills once here: the captain's resume round + any delegated
    workers' usage (seeds + tail, folded by ``resume_plan``) + any revise. Mirrors
    :func:`run_chat_pipeline`'s tail (usage roll-up, per-run ledger, citations,
    message_end), returning the same result shape for the service to persist.
    """
    final_content = join_segments(pre_pause_content, captain_state.content)
    final_reasoning = captain_state.reasoning
    rounds = captain_state.rounds
    turn_usage = (
        TokenUsage.from_usage_dict(captain_state.usage)
        + TokenUsage.from_usage_dict(delegate_tool.usage)
        + TokenUsage.from_usage_dict(revise_tool.usage)
    )
    finish = captain_state.finish_override or (
        FinishReason.END_TURN
        if rounds < profile.max_rounds
        else FinishReason.MAX_ROUNDS
    )
    captain_cost = captain_run_cost_from_state(captain_run_id, captain_state)
    cost_runs = [
        asdict(captain_cost),
        *(asdict(r) for r in delegate_tool.run_ledger),
        *(asdict(r) for r in revise_tool.run_ledger),
    ]
    turn_cost = aggregate_cost(cost_runs)
    merge_citations(citations, delegate_tool.citations)
    merge_citations(citations, revise_tool.citations)
    stray_markers = out_of_range_markers(final_content, len(citations))
    if stray_markers:
        logger.warning(
            "citations.out_of_range",
            message_id=message_id,
            markers=stray_markers,
            citation_count=len(citations),
        )
    if citations:
        sink.emit(citations_event(citations))
    sink.emit(
        message_end(
            finish,
            input_tokens=turn_usage.input_tokens,
            output_tokens=turn_usage.output_tokens,
            reasoning_tokens=turn_usage.reasoning_tokens,
            cache_hit_tokens=turn_usage.cache_hit_tokens,
            cache_miss_tokens=turn_usage.cache_miss_tokens,
            rounds=rounds,
            cost=turn_cost,
        )
    )
    runs = _build_runs_payload(sink, finish)
    return {
        "message_id": message_id,
        "content": final_content,
        "reasoning_content": final_reasoning,
        "input_tokens": turn_usage.input_tokens,
        "output_tokens": turn_usage.output_tokens,
        "reasoning_tokens": turn_usage.reasoning_tokens,
        "rounds": rounds,
        "finish_reason": finish,
        "citations": citations,
        "runs": runs,
        "cost_runs": cost_runs,
    }


def _finish_terminal_resume(
    *, message_id: str, pre_pause_content: str, closing: str, sink: EventSink
) -> dict:
    """Close a resumed ask_user turn that the user STOPPED (结构化挂起 2b terminal).

    No CEO round ran — the closing note is the whole reply (the engine's
    terminal-effect semantics, replayed on resume). The pre-pause CEO round that
    raised the ask_user was never billed (the turn paused before persistence), and a
    stop runs nothing new, so this turn bills nothing — consistent with the「paused
    before persist = never billed」model. The seeded journal (checkpoint_required) +
    the emitted ``checkpoint_resolved`` persist so a reload replays the settled card.
    """
    finish = FinishReason.END_TURN
    sink.emit(message_end(finish, rounds=0))
    runs = _build_runs_payload(sink, finish)
    return {
        "message_id": message_id,
        "content": join_segments(pre_pause_content, closing),
        "reasoning_content": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "rounds": 0,
        "finish_reason": finish,
        "citations": [],
        "runs": runs,
        "cost_runs": [],
    }
