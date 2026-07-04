"""Fresh-turn chat pipeline: Prepare -> Execute -> Finalize."""

import contextlib
from dataclasses import asdict

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.board.channel import BoardChannel
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.protocol import TokenUsage
from agentcore.memory import (
    default_memory_store,
    load_injected_memory,
    load_memory_topics,
)
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.citations import merge_citations, out_of_range_markers
from agentcore.runtime.context import (
    ContextAssembler,
    SectionOrder,
    build_workspace_overview,
)
from agentcore.runtime.costing import RunCost, aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.debate import DebateSeed
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
from agentcore.runtime.pipeline.finalize import _journal_entries_for_turn
from agentcore.runtime.pipeline.prepare import _assemble_ceo_toolset, _build_attachment_context
from agentcore.runtime.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
)
from agentcore.runtime.runs import (
    RunKind,
    RunPhase,
    RunSpec,
    build_captain_executor,
)
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
    per_call_tool_names,
)
from agentcore.tools.builtin.board_ops import BoardOpsTool
from agentcore.tools.builtin.board_read import BoardReadTool
from agentcore.tools.protocol import ToolContext
from agentcore.vision import build_vision_reader
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
    instructions: str | None = None,
    profile_set: ProfileSet | None = None,
    llm_credentials: LLMCredentials | None = None,
    session_saver: SessionSaver | None = None,
    session_loader: SessionLoader | None = None,
    suspension_saver: SuspensionSaver | None = None,
    suspension_deleter: SuspensionDeleter | None = None,
    debate_seed: dict | None = None,
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

    ``folder_id`` is the conversation's project (None for a bare/global chat): it selects
    the memory SCOPE so a project conversation also gets that project's memory layer
    injected (global + project), and ``consult_memory`` searches both (Agent记忆与知识系统 §二).

    ``board_id`` marks this turn as a 白板会话 (AI协作白板.md §六 M2): when set, the CEO
    gains the ``board_ops`` tool + a :class:`BoardChannel` bound to that board, so it can
    apply structured ops to the user's open whiteboard canvas. ``None`` for every ordinary
    chat — then ``board_ops`` is neither wired nor reachable.

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

    # 执行级事件溯源 (§8.3): the turn's single ordered fact log. Bound to the ambient
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
        # Clean, stable base (base + date + memory): NO attachments, NO CEO hints.
        # This is the cacheable prefix shared by the CEO and reused verbatim by
        # workers. The (per-turn, variable) attachment block is appended LAST below —
        # after the stable CEO hint stack — so a turn carrying attached files does not
        # bust DeepSeek's prefix cache for the hints (缓存友好: 易变内容置于稳定前缀之后).
        # 对话级自定义指令 (per-conversation custom instructions): injected here into the
        # shared, cacheable prefix so BOTH the CEO and the reused worker base carry it —
        # the whole team obeys this thread's directive. Stable per conversation ⇒ no
        # per-turn cache bust.
        system_prompt = assemble_system_prompt(
            memory_markdown=memory_markdown, instructions=instructions
        )
        attachment_context = _build_attachment_context(attachments)
        # Workers hold no CEO hints, so their base is the clean base + the same
        # attachment block appended at the end — byte-identical to the old single-call
        # assembly (assemble joins with "\n"), so the delegated team still sees the
        # user's files while the worker's own stable prefix (base) stays cacheable.
        worker_base_prompt = (
            f"{system_prompt}\n{attachment_context}" if attachment_context else system_prompt
        )
        worker_tools = build_worker_registry(backend=backend)
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
            # §九.4: vision provider (QwenVL) — set VISION_API_KEY to enable; None ⇒
            # board_read returns a clean「读图能力未配置」error (「插上即用」).
            vision_reader=build_vision_reader(),
            cost_sink=vision_cost_sink,
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
                file_op_tools=approval_class_tool_names(),
                per_call_tools=per_call_tool_names(),
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
        delegate_tool, revise_tool, debate_tool, chat_tools = _assemble_ceo_toolset(
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
            # 结构化补轮·B：前端从收场卡发起续辩时直传的上一场种子（宽容解析；无实质内容→None）。
            debate_seed=DebateSeed.from_payload(debate_seed),
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

        # 执行级事件溯源 (§8.3): the turn's HEAD fact — the verbatim CEO system prompt
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
            sink.emit(error_event(ErrorCode.PIPELINE_ERROR, err))
            sink.emit(message_end(FinishReason.ERROR))
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
            return {
                "message_id": message_id,
                "content": "",
                "error": err,
                "error_code": ErrorCode.PIPELINE_ERROR,
                "finish_reason": FinishReason.ERROR,
                "cost_runs": cost_runs,
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
        # captain_state.cost/.usage) + the delegated workers' usage + every 定向唤回
        # (revise) continuation's usage, both accumulated on their tool instances
        # across the turn. ``delegate`` / ``revise`` are non-terminal, so the captain
        # loop never metered their tokens; the cache split rides along so the folded
        # total stays priceable.
        turn_usage = (
            TokenUsage.from_usage_dict(captain_state.usage)
            + TokenUsage.from_usage_dict(delegate_tool.usage)
            + TokenUsage.from_usage_dict(revise_tool.usage)
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
            # Each 定向唤回 (revise) continuation is its own member run row, parented
            # to the original worker so the version chain is reconstructable (决策②).
            *(asdict(r) for r in revise_tool.run_ledger),
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
        merge_citations(citations, revise_tool.citations)
        merge_citations(citations, debate_tool.citations)

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

        journal_entries = _journal_entries_for_turn(fact_log, sink=sink, finish=finish)

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
            # chat.turn_complete — boundary_yields / scope_signals / escalations off the
            # delegate accumulator, plus the revise count (定向唤回 次数 = 返工 的另一半).
            "collab": {
                **delegate_tool.collab,
                "revises": len(revise_tool.run_ledger),
            },
        }

    except Exception as e:
        logger.error("pipeline.error", error=str(e), exc_info=True)
        # Preserve a structured AgentCoreError.code that escaped to the pipeline
        # boundary (e.g. LLM_KEY_INVALID) instead of flattening every crash to
        # PIPELINE_ERROR — the client only acts on specific codes (统一错误码).
        code, message = error_fields_for(
            e, fallback_code=ErrorCode.PIPELINE_ERROR, fallback_message=str(e)
        )
        sink.emit(error_event(code, message))
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
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "error_code": code,
            "finish_reason": FinishReason.ERROR,
            "journal_entries": crash_journal,
        }
    finally:
        current_fact_log.reset(fact_log_token)
        turn_history.reset(history_token)
        # Do NOT close the sink here. The pipeline is a *producer* on a sink it did not
        # create; closing it would silently drop the post-turn tail (title_generated /
        # followups_generated), which persist_turn_result emits AFTER this returns —
        # emit() is a no-op once closed (sink.py). The sink's OWNER (the coordinator that
        # created it: stream_chat / regenerate_chat / resume_chat / handoff / sidecar)
        # closes it, so the tail reaches the client. (Title survived the old early-close
        # via its DB write; transport-only followups vanished — the 「下一步推荐」 bug.)
        with contextlib.suppress(Exception):
            await llm.close()
