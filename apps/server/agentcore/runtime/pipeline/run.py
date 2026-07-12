"""Fresh-turn chat pipeline: Prepare -> Execute -> Finalize."""

import contextlib
from dataclasses import asdict

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.board.channel import BoardChannel
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import AutonomyPolicy, new_id
from agentcore.desktop.channel import DesktopClientChannel
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import turn_profiles_for_turn
from agentcore.llm.provider.protocol import TokenUsage
from agentcore.memory import (
    default_memory_store,
    load_injected_memory,
    load_memory_topics,
)
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.audit.hooks import bind_recorder
from agentcore.runtime.citations import merge_citations, reconcile_citations
from agentcore.runtime.context import (
    ContextAssembler,
    SectionOrder,
    build_workspace_context,
    build_workspace_overview,
    desktop_client_can_bind,
)
from agentcore.runtime.costing import RunCost, aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    citations_event,
    error_event,
    message_end,
    message_start,
)
from agentcore.runtime.facts import (
    TurnFactLog,
    TurnStartedFact,
    current_fact_log,
    record_turn_fact,
)
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.journal.writer import TurnJournalWriter, current_journal_writer
from agentcore.runtime.pipeline.finalize import _journal_entries_for_turn
from agentcore.runtime.resolve.prepare import (
    _assemble_ceo_toolset,
    _build_attachment_context,
    _wire_worker_memory_tools,
)
from agentcore.runtime.resolve.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    compose_worker_base_prompt,
)
from agentcore.runtime.runs import (
    RunKind,
    RunPhase,
    RunSpec,
    build_captain_executor,
)
from agentcore.runtime.session_persistence import SessionRosterWriter
from agentcore.runtime.sessions import (
    SessionLoader,
    SessionSaver,
    default_session_registry,
)
from agentcore.runtime.skills import (
    build_system_skill_registry,
)
from agentcore.runtime.suspension import (
    SuspensionDeleter,
    SuspensionSaver,
    turn_history,
)
from agentcore.tools.builtin import (
    approval_class_tool_names,
    build_worker_registry,
    delegation_grantable_tool_names,
    per_call_tool_names,
)
from agentcore.tools.builtin.board_ops import BoardOpsTool
from agentcore.tools.builtin.board_read import BoardReadTool
from agentcore.tools.protocol import ToolContext
from agentcore.vision import build_vision_reader
from agentcore.workspace.locate import workspace_channel_for_tools
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


async def run_chat_pipeline(
    *,
    conversation_id: str,
    user_message: str,
    history: list[dict],
    sink: EventSink,
    user_id: str,
    backend: WorkspaceBackend,
    folder_id: str | None = None,
    board_id: str | None = None,
    attachments: list[dict] | None = None,
    approvals_enabled: bool = True,
    memory_enabled: bool = True,
    autonomy_policy: AutonomyPolicy | None = None,
    profile_set: ProfileSet | None = None,
    llm_credentials: LLMCredentials | None = None,
    session_saver: SessionSaver | None = None,
    session_loader: SessionLoader | None = None,
    suspension_saver: SuspensionSaver | None = None,
    suspension_deleter: SuspensionDeleter | None = None,
    llm_supports_tools: bool | None = None,
    message_id: str | None = None,
    x_client_platform: str | None = None,
) -> dict:
    """Run the full chat pipeline for a single user message.

    Returns a dict with final_content, usage, and metadata.
    The sink receives all SSE events during execution.

    ``approvals_enabled`` gates GRANTABLE tools behind the user's consent (the
    default interactive path). It is set False for an autonomous local→云 handoff
    job (双模式工作区 P2e / e2): that run has no live client to answer prompts and
    operates on an isolated server sandbox, so — like cloud-mode workers — it needs
    no gate; leaving it on would deadlock every file/exec tool on a timeout-deny.

    ``memory_enabled`` is the user's long-term-memory master switch (resolved by the
    caller): False injects no memory <rules> this turn (Agent记忆与知识系统 §一).

    ``autonomy_policy`` is the user's capability-authorization posture (安全权限与治理
    §三): always_ask / first_grant (default) / full_auto. Only the capability-auth
    dimension — plan_review / checkpoint confirmation is unchanged.

    ``folder_id`` is the conversation's project (None for a bare/global chat): it selects
    the memory SCOPE so a project conversation also gets that project's memory layer
    injected (global + project), and ``consult_memory`` searches both (Agent记忆与知识系统 §二).

    ``board_id`` marks this turn as a 白板会话 (AI协作白板.md §六 M2): when set, the CEO
    gains the ``board_ops`` tool + a :class:`BoardChannel` bound to that board, so it can
    apply structured ops to the user's open whiteboard canvas. ``None`` for every ordinary
    chat — then ``board_ops`` is neither wired nor reachable.

    ``x_client_platform`` is the raw ``X-Client-Platform`` header (desktop / mobile-web /
    …). Gates ``ask_user``'s ``action=bind_local_folder`` advertisement and the
    ``<workspace_context>`` desktop-online line — cloud web/mobile must not see the bind
    action. ``None`` / absent defaults to desktop (legacy tests).

    ``profile_set`` is the turn's per-scenario model set — which model each scenario
    (chat / agent.strong / ...) runs this turn — resolved by the caller from the user's
    configured model. ``None`` (e.g. the autonomous handoff job) falls back to the
    default profile set.

    ``llm_credentials`` are the turn's resolved BYOK key + endpoint (config.
    billing_mode); the caller resolves them once (route preflight) and threads them
    here so the whole turn runs on the user's own DeepSeek quota. ``None`` falls
    back to the global server key (platform mode).
    """
    profiles = turn_profiles_for_turn(profile_set, llm_credentials)
    message_id = message_id or new_id()
    # The CEO captain is the turn's root Run node (kind=captain): it owns the reply
    # voice and may delegate. Its run id parents every delegated member's ledger row
    # and labels the captain cost row; agent_id == run_id (阶段1 convention). When
    # the CEO delegates, this id is declared as the graph's CAPTAIN 汇聚点 the
    # workers hang under (see delegate.plan_events.plan_event).
    captain_run_id = new_id()

    # 执行级事件溯源 (§8.3): the turn's single ordered fact log. Bound to the ambient
    # contextvar BEFORE any sink.emit / captain run so the engine's execution facts
    # (round_boundary / llm_call / note / message_final) AND the sink's display facts
    # (run_*/tool_use_*/interaction) accumulate here in ONE order — copied into each
    # delegated worker's task, so the whole team writes to this log. Reset in finally.
    fact_log = TurnFactLog()
    fact_log_token = current_fact_log.set(fact_log)
    # Append-on-emit: every fact is durably written before its SSE event is delivered.
    from agentcore.core.log_context import get_log_value

    journal_writer = TurnJournalWriter(
        turn_id=message_id,
        conversation_id=conversation_id,
        trace_id=get_log_value("trace_id"),
    )
    journal_writer_token = current_journal_writer.set(journal_writer)
    audit_recorder, audit_token = bind_recorder(
        user_id=user_id,
        conversation_id=conversation_id,
        turn_id=message_id,
        trace_id=get_log_value("trace_id"),
        captain_run_id=captain_run_id,
    )
    # Session roster write-through (as-built: 成本配额 §三): fire-and-forget on the hot path,
    # flush with audit at turn-end so cross-turn load-on-miss stays durable.
    roster_writer = SessionRosterWriter.wrap(session_saver)
    session_saver = roster_writer.save if roster_writer is not None else None
    # 执行级事件溯源 Phase 2 ⑤: publish this turn's history so a suspending face captures it
    # into the durable frame — the resume window splices it ahead of the journal-folded
    # rounds (the journal stores only history's LENGTH). Reset in finally.
    history_token = turn_history.set(history)
    # CEO 协调模式: turn-level execution_id for registry lookup (captain wait path).
    # Bound after base_tool_context is minted (inside try); reset in finally.
    execution_id_token = None
    bound_execution_id: str | None = None

    try:
        # --- Phase 1: Prepare ---
        # Long-term memory injection is gated by the user's master switch (Agent记忆
        # 与知识系统 §一): when off we inject nothing (an empty body drops the <rules>
        # memory section entirely), so a user who turned memory off sees zero influence
        # from it this turn — the privacy off-ramp's inject half (the grow half is
        # gated in memory/consolidation.py).
        # 记忆作用域 (§5.2): the always-injected core spans global 偏好.md + 画像.md and — when
        # the conversation is in a project — that project's 画像.md, concatenated global-first
        # (stable prefix) into one <rules> body. Master switch off ⇒ "".
        memory_store = default_memory_store()
        memory_markdown = await load_injected_memory(
            memory_store,
            user_id,
            folder_id=folder_id,
            enabled=memory_enabled,
            file_char_cap=settings.memory_injected_file_char_cap,
        )
        # 记忆主题目录 (记忆文件夹化 §六 / 作用域 §5.2): the on-demand TOPIC notes (主题/<slug>.md)
        # are never injected wholesale — only their NAMES (merged across global + project)
        # ride the CEO prompt, and the CEO pulls a note's full body via consult_memory when
        # relevant. Same master-switch gate: off ⇒ [] ⇒ no directory rendered, no tool wired.
        memory_topics = await load_memory_topics(
            memory_store, user_id, folder_id=folder_id, enabled=memory_enabled
        )
        # Clean, stable base (base + date + workspace facts + memory): NO attachments,
        # NO CEO hints. This is the cacheable prefix shared by the CEO and reused
        # verbatim by workers. Environment facts ride the shared base so workers also
        # know execution location (防止空云 scratch 里幻觉装软件). The (per-turn, variable)
        # attachment block is appended LAST below — after the stable CEO hint stack —
        # so a turn carrying attached files does not bust DeepSeek's prefix cache for
        # the hints (缓存友好: 易变内容置于稳定前缀之后).
        desktop_online = desktop_client_can_bind(x_client_platform) or backend.location == "local"
        workspace_facts = build_workspace_context(backend, desktop_online=desktop_online)
        system_prompt = assemble_system_prompt(
            memory_markdown=memory_markdown,
            workspace_context=workspace_facts,
        )
        attachment_context = _build_attachment_context(attachments)
        # Workers hold no CEO hints; their base is the shared base + optional simplified
        # 记忆主题目录 + the same attachment block at the end — byte-identical to the old
        # single-call assembly when memory is off and no topics exist.
        worker_base_prompt = compose_worker_base_prompt(
            system_prompt,
            memory_topics=memory_topics,
            memory_enabled=memory_enabled,
            attachment_context=attachment_context,
        )
        worker_tools = build_worker_registry(backend=backend)
        _wire_worker_memory_tools(
            worker_tools, memory_enabled=memory_enabled, folder_id=folder_id
        )
        # System skills (提示词瘦身 P2): the advanced-mechanism guidance the CEO pulls
        # on demand via consult_skill. Built once per turn; backs the tool AND the
        # always-on 能力目录 rendered into the CEO prompt below. Legal vertical v0 layers
        # its domain skill in only when enabled (法律垂直「答辩状作战室」, off by default).
        skill_registry = build_system_skill_registry(include_legal=settings.legal_vertical_enabled)
        # 真·多模型辩手：回合 llm = DeepSeek 默认（``build_provider``，保留可测试打桩的 seam）
        # 外包一层 ProviderRouter。无前缀模型（CEO / 委派 / 主持人）照走默认，仅辩论辩手 side
        # 带 ``provider/model`` 前缀的调用路由到对应厂商。无厂商 key 时只是空包一层，零行为变化。
        # 路由器接管默认 + 厂商 client 的生命周期，由下方 finally 的 ``await llm.close()`` 释放。
        llm = pipeline_pkg.build_router_around(pipeline_pkg.build_provider(llm_credentials))

        # AI 协作白板 (§六 M2): a board-bound turn gets a BoardChannel so ``board_ops`` can
        # reach the user's open canvas via the desktop. Bound to this board + conversation
        # on the shared interaction bridge (same registry the resolve endpoint settles).
        # ``None`` for an ordinary chat — then the tool below is never wired either.
        board_channel = (
            BoardChannel(
                sink=sink,
                conversation_id=conversation_id,
                board_id=board_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.board_op_timeout_seconds,
            )
            if board_id
            else None
        )
        desktop_channel = (
            DesktopClientChannel(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.board_op_timeout_seconds,
            )
            if backend.location == "local"
            else None
        )
        workspace_channel = workspace_channel_for_tools(
            backend,
            sink=sink,
            conversation_id=conversation_id,
        )

        # AI 协作白板 §九.4 Gap ②: the turn-level vision cost sink. ``board_read`` appends a
        # priced ``role=vision`` ledger row here per 读图 sub-call. Shared by REFERENCE across
        # every derived run context (executor uses ``replace``, which copies the list ref), so
        # a vision call from any run — captain or a delegated worker — lands in this one list,
        # collected into ``cost_runs`` after the turn. Empty unless a board_read actually billed.
        vision_cost_sink: list[RunCost] = []

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
            board_channel=board_channel,
            desktop_channel=desktop_channel,
            workspace_channel=workspace_channel,
            # §九.4: vision provider (QwenVL) — set VISION_API_KEY to enable; None ⇒
            # board_read returns a clean「读图能力未配置」error (「插上即用」).
            vision_reader=build_vision_reader(),
            cost_sink=vision_cost_sink,
        )
        from agentcore.runtime.coordination.session import current_execution_id

        bound_execution_id = base_tool_context.execution_id
        execution_id_token = current_execution_id.set(bound_execution_id)

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
        # Workers get the full production ``worker_tools`` plus, by default,
        # ``delegate``+``replan`` when ``depth < MAX_DELEGATION_DEPTH`` (worker
        # captains may nest one sub-team; ``can_delegate=false`` opts out;
        # depth-2 sub-workers are leaves; per-captain fan-out capped at
        # ``MAX_WORKER_SUBDELEGATIONS``).
        # Approval gate (one per turn so an "allow for the rest of this turn" grant
        # is scoped to this message and does not leak across turns). It is wired into
        # the CEO's loop, but with the coordinator boundary the CEO holds no
        # GRANTABLE tools — so approvals now bite at the WORKER layer: the SAME
        # instance is handed to the delegate tool, which forwards it to workers ONLY
        # in local mode (双模式工作区 P2d 执行门) — so a delegated worker can't run
        # code / mutate files on the user's real machine without consent, while a
        # cloud team stays un-gated (isolated sandbox).
        if autonomy_policy is None:
            autonomy_policy = AutonomyPolicy.FIRST_GRANT
        approval_gate = (
            ApprovalGate(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
                timeout_overrides=settings.approval_timeout_overrides,
                file_op_tools=approval_class_tool_names(),
                per_call_tools=per_call_tool_names(),
                delegation_grantable_tools=delegation_grantable_tool_names(),
                autonomy_policy=autonomy_policy,
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
        delegate_tool, debate_tool, chat_tools = _assemble_ceo_toolset(
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
            memory_enabled=memory_enabled,
            folder_id=folder_id,
            autonomy_policy=autonomy_policy,
            # Same live-user gate as ask_user itself, plus desktop-only: web/mobile omit.
            advertise_bind_local_folder=checkpoint_enabled and desktop_client_can_bind(
                x_client_platform
            ),
        )

        # AI 协作白板: in a 白板会话, hand the CEO the board tools so it can draw on
        # (``board_ops``, §六 M2) and read (``board_read``, §九) the user's open canvas.
        # Registered AFTER the coordinator toolset is assembled and BEFORE ``ceo_tool_names``
        # is read, so they join the LLM's function catalog this turn. Only here (board-bound
        # runs) — every other chat never sees them.
        if board_channel is not None:
            chat_tools.register(BoardOpsTool())
            chat_tools.register(BoardReadTool())

        # The entry chat agent gets the SLIM CEO core + the always-on 能力目录 (提示词
        # 瘦身 P2) + inline citation guidance. The directory lists only the skills whose
        # required tools are actually wired this turn (derived from the assembled CEO
        # toolset), so it never advertises a capability the CEO does not hold (e.g.
        # the ask_user_* skills appear only on the live-user path, when ask_user is wired)
        # — the same invariant the old per-hint gating enforced. The advanced「怎么做」
        # detail no longer rides every turn; the CEO pulls it via consult_skill.
        ceo_tool_names = {schema.name for schema in chat_tools.list_all()}
        chat_system_prompt = compose_ceo_chat_prompt(
            system_prompt,
            skill_registry=skill_registry,
            ceo_tool_names=ceo_tool_names,
            memory_topics=memory_topics,
        )
        # Real-time workspace overview (工作区上下文): a compact, newest-first listing of
        # the files already on disk in this conversation's workspace, so the CEO can
        # triage / delegate without spending a blind file_list round. Generated fresh
        # each turn from the live backend (never indexed → never stale); "" when empty /
        # unavailable. Workers don't get this — they already receive the richer per-run
        # manifest (runs/executor_context._workspace_manifest).
        workspace_overview = await build_workspace_overview(backend)
        # Variable tail AFTER the stable hint stack (workspace overview + attachments) so
        # the CEO prefix (base + hints) stays byte-identical across turns and rides the
        # prefix cache even when the workspace / attachments change. Empty sections are
        # dropped, so a turn with neither is byte-identical to the bare CEO prompt.
        chat_system_prompt = (
            ContextAssembler()
            .add("ceo_prompt", chat_system_prompt, SectionOrder.BASE)
            .add("workspace_context", workspace_overview, SectionOrder.WORKSPACE_OVERVIEW)
            .add("attachment_context", attachment_context, SectionOrder.ATTACHMENT)
            # COST-004 (仅观测起步): 埋本回合 CEO 系统提示的逐段 chars + 是否越软闸, 攒据用、零行为
            # 改动。此处是「易变尾 (workspace/attachment)」与稳定前缀 (ceo_prompt) 同框的 choke
            # point, 正是未来「仅裁易变尾」软闸的作用点 (项目审计-成本性能专项 §九)。
            .observe(scope="ceo_turn", soft_cap=settings.prompt_budget_char_soft_cap)
            .render()
        )

        # --- Phase 3: Execute ---
        sink.emit(message_start(message_id, conversation_id=conversation_id))

        profile = profiles.get("chat")
        turn_model = profiles.model_for("chat")

        record_turn_fact(
            TurnStartedFact(
                system_prompt=chat_system_prompt,
                user_message=user_message,
                model_profile=turn_model,
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
            turn_model=turn_model,
            citation_sink=citations,
            approval_gate=approval_gate,
            supports_tools=llm_supports_tools,
        )
        captain_state = await run_captain(captain_spec)

        if captain_state.phase is RunPhase.FAILED:
            err = captain_state.error or "captain run failed"
            sink.emit(error_event(ErrorCode.PIPELINE_ERROR, err))
            sink.emit(message_end(FinishReason.ERROR))
            # Salvage longest available text (segment / captain_state / sink) — P1 §3.4.
            with contextlib.suppress(Exception):
                await sink.flush_stream_state()
            from agentcore.conversation.store.merge import pick_longest
            from agentcore.runtime.events.stream_checkpointer import (
                CHANNEL_CAPTAIN_CONTENT,
                CHANNEL_CAPTAIN_REASONING,
            )

            mem = sink.stream_memory_snapshot()
            salvaged_content = pick_longest(
                mem.get(CHANNEL_CAPTAIN_CONTENT),
                captain_state.content,
                sink.streamed_content(),
            )
            salvaged_reasoning = pick_longest(
                mem.get(CHANNEL_CAPTAIN_REASONING),
                captain_state.reasoning,
                sink.streamed_reasoning(),
            )
            # A captain that died mid-loop still burned tokens (B-deep 失败计费): the
            # executor priced them onto captain_state, so carry the captain ledger row
            # back even on error — _persist_turn_result writes cost_runs independently
            # of whether any assistant text landed. Skip when nothing metered (no
            # usage → no row), so a pre-LLM crash stays free.
            cost_runs = [
                *(
                    [asdict(captain_run_cost_from_state(captain_run_id, captain_state))]
                    if captain_state.usage
                    else []
                ),
                # A board_read 读图 sub-call may have billed before the captain died
                # (§九.4 Gap ②): carry those vision rows so the spend isn't lost on error.
                *(asdict(r) for r in vision_cost_sink),
            ]
            await audit_recorder.flush()
            if roster_writer is not None:
                await roster_writer.flush()
            return {
                "message_id": message_id,
                "content": salvaged_content,
                "reasoning_content": salvaged_reasoning or None,
                "error": err,
                "error_code": ErrorCode.PIPELINE_ERROR,
                "finish_reason": FinishReason.ERROR,
                "cost_runs": cost_runs,
                "audit_drops": audit_recorder.drops,
            }

        # 受监督的波循环 P5「Edge」: if the CEO yielded at a delegate boundary (晚绑定 / scope)
        # but ended the turn without a ``replan``, fold the已完成 workers' usage / ledger /
        # citations in and release the dangling supervised plan (implicit stop) — else that
        # work would be unbilled and its sources unshown. No-op when nothing is paused, so a
        # normal turn is untouched. Must run BEFORE the turn usage / cost / citations fold.
        await delegate_tool.dispose_open_supervised()

        final_content = captain_state.content
        final_reasoning = captain_state.reasoning
        rounds = captain_state.rounds

        # Turn usage = the captain run's own spend (priced once in the executor onto
        # captain_state.cost/.usage) + the delegated workers' usage + every 续派
        # continuation's usage (folded into delegate via continue_from / redirect),
        # both accumulated on their tool instances across the turn. ``delegate`` is
        # non-terminal, so the captain loop never metered their tokens; the cache
        # split rides along so the folded total stays priceable.
        turn_usage = (
            TokenUsage.from_usage_dict(captain_state.usage)
            + TokenUsage.from_usage_dict(delegate_tool.usage)
            + TokenUsage.from_usage_dict(debate_tool.usage)
        )
        finish = captain_state.finish_override or (
            FinishReason.END_TURN if rounds < profile.max_rounds else FinishReason.MAX_ROUNDS
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
            # 辩论：主持人一行 + 每个辩手每轮一行（含 continue_run 续写），各自 parented
            # 到上级（辩手→主持人、主持人→captain），与 delegate 同形折账。
            *(asdict(r) for r in debate_tool.run_ledger),
            # AI 协作白板 读图: each board_read 视觉子调用 is its own role=vision row,
            # parented to the calling run (§九.4 Gap ②). Empty unless a read billed.
            *(asdict(r) for r in vision_cost_sink),
        ]
        turn_cost = aggregate_cost(cost_runs)

        # Fold the delegated workers' web sources into the turn's shared card
        # (deduped/capped against the CEO's own searches). The CEO collected its
        # sources live during the loop (numbered + cited inline); workers collected
        # theirs un-numbered, so appending them here keeps the CEO's [n] stable and
        # still surfaces the WHOLE team's research to the user. Mirrors how worker
        # usage/cost are folded back off the delegate tool instance above.
        merge_citations(citations, delegate_tool.citations)
        merge_citations(citations, debate_tool.citations)

        # 引用出口自洽：finish_guard 回炉耗尽后正文仍可能带悬空 [n]。先记 warning
        #（观测），再剥离悬空角标，保证进入 conversation store 的终稿与 citations 自洽。
        final_content, citations, stray_markers = reconcile_citations(final_content, citations)
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

        collab = {
            **delegate_tool.collab,
            "revises": delegate_tool.continuation_count,
            "audit_drops": audit_recorder.drops,
        }
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
                collab=collab,
            )
        )

        journal_entries = _journal_entries_for_turn(fact_log, sink=sink, finish=finish)

        # Drain journal → audit projection fully BEFORE 定格 audit_drops: the teardown
        # flush (finally) re-drains the writer, which can schedule + drop more audit
        # writes after drops was read — undercounting the persisted turn_metrics.audit_drops
        # (采集降级遥测 → admin aggregate). Mirror the finally order (journal then recorder);
        # best-effort so a drain fault never turns a successful turn into an error.
        with contextlib.suppress(Exception):
            await journal_writer.flush()
        await audit_recorder.flush()
        if roster_writer is not None:
            await roster_writer.flush()
        # 回合收口前 boundary flush (P1) — segments cleared after finalize snapshot.
        with contextlib.suppress(Exception):
            await sink.flush_stream_state()
        return {
            "message_id": message_id,
            "content": final_content,
            "reasoning_content": final_reasoning,
            "input_tokens": turn_usage.input_tokens,
            "output_tokens": turn_usage.output_tokens,
            "reasoning_tokens": turn_usage.reasoning_tokens,
            "cache_hit_tokens": turn_usage.cache_hit_tokens,
            "cache_miss_tokens": turn_usage.cache_miss_tokens,
            "rounds": rounds,
            "finish_reason": finish,
            "citations": citations,
            "cost_runs": cost_runs,
            "journal_entries": journal_entries,
            # 协作质量 (学·度量 §2.5): turn-level orchestration signals for turn_metrics +
            # chat.turn_complete / message_end — boundary_yields / scope_signals /
            # escalations off the delegate accumulator, plus the revise count (定向唤回).
            "collab": collab,
            "audit_drops": audit_recorder.drops,
        }

    except Exception as e:
        logger.error("pipeline.error", error=str(e), exc_info=True)
        # Preserve a structured AgentCoreError.code that escaped to the pipeline
        # boundary (e.g. LLM_KEY_INVALID) instead of flattening every crash to
        # PIPELINE_ERROR — the client only acts on specific codes (统一错误码).
        code, message, err_ctx = error_fields_for(
            e, fallback_code=ErrorCode.PIPELINE_ERROR, fallback_message=str(e)
        )
        sink.emit(error_event(code, message, context=err_ctx))
        sink.emit(message_end(FinishReason.ERROR))
        # 异常也落库: a crash mid-turn must NOT discard already-finished work (a
        # completed debate / delegated workers). Carry the journal so persist_turn_result
        # writes it under the abnormal message even with empty reply content — otherwise a
        # 6-min debate that survived the turn would vanish on the next refresh. Best-effort:
        # never let journal assembly mask the original error.
        try:
            crash_journal = _journal_entries_for_turn(
                fact_log, sink=sink, finish=FinishReason.ERROR
            )
        except Exception:  # noqa: BLE001 — salvage is best-effort; keep the real error
            crash_journal = None
        # Salvage longest available text from segment / sink (captain_state may be absent).
        with contextlib.suppress(Exception):
            await sink.flush_stream_state()
        from agentcore.conversation.store.merge import pick_longest
        from agentcore.runtime.events.stream_checkpointer import (
            CHANNEL_CAPTAIN_CONTENT,
            CHANNEL_CAPTAIN_REASONING,
        )

        mem = sink.stream_memory_snapshot()
        salvaged_content = pick_longest(
            mem.get(CHANNEL_CAPTAIN_CONTENT),
            sink.streamed_content(),
        )
        salvaged_reasoning = pick_longest(
            mem.get(CHANNEL_CAPTAIN_REASONING),
            sink.streamed_reasoning(),
        )
        await audit_recorder.flush()
        if roster_writer is not None:
            await roster_writer.flush()
        return {
            "message_id": message_id,
            "content": salvaged_content,
            "reasoning_content": salvaged_reasoning or None,
            "error": str(e),
            "error_code": code,
            "finish_reason": FinishReason.ERROR,
            "journal_entries": crash_journal,
            "audit_drops": audit_recorder.drops,
        }
    finally:
        # 触发点①：turn 结束防御性 orphan 未 settle 的热路交互
        with contextlib.suppress(Exception):
            from agentcore.runtime.interaction_orphan import orphan_registry_pending

            await orphan_registry_pending(
                conversation_id, turn_id=message_id
            )
        current_fact_log.reset(fact_log_token)
        # Drain the append-on-emit journal BEFORE dropping the writer: an abandoned in-flight
        # write leaves a checked-out DB connection for the GC to terminate (asyncpg
        # connection_lost noise). Best-effort — a drain failure must never break turn teardown.
        with contextlib.suppress(Exception):
            await journal_writer.flush()
        current_journal_writer.reset(journal_writer_token)
        from agentcore.runtime.audit.recorder import current_audit_recorder

        with contextlib.suppress(Exception):
            await audit_recorder.flush()
        with contextlib.suppress(Exception):
            if roster_writer is not None:
                await roster_writer.flush()
        current_audit_recorder.reset(audit_token)
        turn_history.reset(history_token)
        if execution_id_token is not None:
            from agentcore.runtime.coordination.session import (
                clear_active_coordination,
                current_execution_id,
            )

            if bound_execution_id:
                with contextlib.suppress(Exception):
                    clear_active_coordination(bound_execution_id)
            current_execution_id.reset(execution_id_token)
        # Do NOT close the sink here. The pipeline is a *producer* on a sink it did not
        # create; closing it would silently drop the post-turn tail (title_generated /
        # followups_generated), which persist_turn_result emits AFTER this returns —
        # emit() is a no-op once closed (sink.py). The sink's OWNER (the coordinator that
        # created it: stream_chat / regenerate_chat / resume_chat / handoff / sidecar)
        # closes it, so the tail reaches the client. (Title survived the old early-close
        # via its DB write; transport-only followups vanished — the 「下一步推荐」 bug.)
        with contextlib.suppress(Exception):
            await llm.close()
