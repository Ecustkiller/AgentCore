"""Fresh-turn chat pipeline: Prepare -> Execute -> Finalize."""

from agentcore.runtime.pipeline.prepare import _assemble_ceo_toolset, _build_attachment_context
from agentcore.runtime.pipeline.finalize import _build_runs_payload, _durable_journal_entries
import agentcore.runtime.pipeline as pipeline_pkg

import contextlib
from dataclasses import asdict
from typing import Any, NamedTuple

from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect, new_id
from agentcore.llm.byok import LLMCredentials
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
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.journal import (
    completed_from_journal,
    entries_from_runs,
    plan_from_journal,
    window_from_journal,
)
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
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.revise import ReviseTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
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
        llm = pipeline_pkg.build_provider(llm_credentials)

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
            sink.emit(error_event(ErrorCode.PIPELINE_ERROR, err))
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
                "error_code": ErrorCode.PIPELINE_ERROR,
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
            + TokenUsage.from_usage_dict(debate_tool.usage)
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
            # 辩论：主持人一行 + 每个辩手每轮一行（含 continue_run 续写），各自 parented
            # 到上级（辩手→主持人、主持人→captain），与 delegate 同形折账。
            *(asdict(r) for r in debate_tool.run_ledger),
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
            "cache_hit_tokens": turn_usage.cache_hit_tokens,
            "cache_miss_tokens": turn_usage.cache_miss_tokens,
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
        # Preserve a structured AgentCoreError.code that escaped to the pipeline
        # boundary (e.g. LLM_KEY_INVALID) instead of flattening every crash to
        # PIPELINE_ERROR — the client only acts on specific codes (统一错误码).
        code, message = error_fields_for(
            e, fallback_code=ErrorCode.PIPELINE_ERROR, fallback_message=str(e)
        )
        sink.emit(error_event(code, message))
        sink.emit(message_end(FinishReason.ERROR))
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "error_code": code,
            "finish_reason": FinishReason.ERROR,
        }
    finally:
        current_fact_log.reset(fact_log_token)
        turn_history.reset(history_token)
        sink.close()
        with contextlib.suppress(Exception):
            await llm.close()
