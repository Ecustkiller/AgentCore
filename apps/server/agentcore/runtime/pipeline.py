"""ChatPipeline: Prepare -> Execute -> Finalize.

Orchestrates a single user message through the full lifecycle:
  1. Prepare  — build context, resolve prompt/model/tools, load history
  2. Execute  — run ReAct loop, stream events
  3. Finalize — persist assistant message, update conversation
"""

import contextlib
from dataclasses import asdict

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.config import get_profile
from agentcore.llm.factory import build_provider
from agentcore.llm.protocol import TokenUsage
from agentcore.memory import default_memory_store
from agentcore.runtime.approvals import ApprovalGate, default_approval_registry
from agentcore.runtime.citations import merge_citations
from agentcore.runtime.costing import aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    citations_event,
    error_event,
    message_end,
    message_start,
)
from agentcore.runtime.prompt import (
    CHAT_CITATION_HINT,
    CHAT_TEAM_CAPABILITY_HINT,
    assemble_system_prompt,
)
from agentcore.runtime.runs import RunKind, RunPhase, RunSpec, build_captain_executor
from agentcore.tools.builtin import build_builtin_registry, build_ceo_tool_registry
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


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
) -> dict:
    """Run the full chat pipeline for a single user message.

    Returns a dict with final_content, usage, and metadata.
    The sink receives all SSE events during execution.

    ``approvals_enabled`` gates GRANTABLE tools behind the user's consent (the
    default interactive path). It is set False for an autonomous local→云 handoff
    job (双模式工作区 P2e / e2): that run has no live client to answer prompts and
    operates on an isolated server sandbox, so — like cloud-mode workers — it needs
    no gate; leaving it on would deadlock every file/exec tool on a timeout-deny.
    """
    message_id = new_id()
    # The CEO captain is the turn's root Run node (kind=captain): it owns the reply
    # voice and may delegate. Its run id parents every delegated member's ledger row
    # and labels the captain cost row; agent_id == run_id (阶段1 convention). When
    # the CEO delegates, this id is declared as the graph's CAPTAIN 汇聚点 the
    # workers hang under (see DelegateTool._plan_event).
    captain_run_id = new_id()

    try:
        # --- Phase 1: Prepare ---
        memory_markdown = await default_memory_store().load(user_id)
        system_prompt = assemble_system_prompt(
            memory_markdown=memory_markdown,
            extra_context=_build_attachment_context(attachments),
        )
        worker_tools = build_builtin_registry()
        llm = build_provider()

        # The workspace backend is resolved per conversation by the caller
        # (folder space vs. its own conversation space) and injected here. The
        # engine and tools never see a Path — they only touch ``context.backend``.
        base_tool_context = ToolContext(
            execution_id=new_id(),
            run_id=new_id(),
            agent_id="default",
            backend=backend,
            user_id=user_id,
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
                registry=default_approval_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
            )
            if (settings.approval_gate_enabled and approvals_enabled)
            else None
        )
        # The delegate tool gets the CLEAN base prompt — it is reused verbatim by
        # the workers (runs/executor.py), which must not be told about a delegate
        # tool they do not hold.
        delegate_tool = DelegateTool(
            llm=llm,
            sink=sink,
            system_prompt=system_prompt,
            user_message=user_message,
            history=history,
            tools=worker_tools,
            base_tool_context=base_tool_context,
            captain_run_id=captain_run_id,
            approval_gate=approval_gate,
        )
        chat_tools = build_ceo_tool_registry()
        chat_tools.register(delegate_tool)

        # The entry chat agent additionally learns it may escalate to a team and
        # how to cite web sources inline (single-agent path only — see prompt.py).
        chat_system_prompt = (
            f"{system_prompt}\n{CHAT_TEAM_CAPABILITY_HINT}\n{CHAT_CITATION_HINT}"
        )

        # --- Phase 3: Execute ---
        sink.emit(message_start(message_id, conversation_id=conversation_id))

        profile = get_profile("chat")
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
            return {
                "message_id": message_id,
                "content": "",
                "error": err,
                "finish_reason": FinishReason.ERROR,
            }

        final_content = captain_state.content
        final_reasoning = captain_state.reasoning
        rounds = captain_state.rounds

        # Turn usage = the captain run's own spend (priced once in the executor onto
        # captain_state.cost/.usage) + the delegated workers' usage accumulated on
        # the tool instance across every delegate call this turn. ``delegate`` is
        # non-terminal, so the captain loop never metered the workers' tokens; the
        # cache split rides along so the folded total stays priceable.
        turn_usage = TokenUsage(
            input_tokens=captain_state.usage.get("input", 0),
            output_tokens=captain_state.usage.get("output", 0),
            reasoning_tokens=captain_state.usage.get("reasoning", 0),
            cache_hit_tokens=captain_state.usage.get("cache_hit", 0),
            cache_miss_tokens=captain_state.usage.get("cache_miss", 0),
        ) + TokenUsage(
            input_tokens=delegate_tool.usage["input"],
            output_tokens=delegate_tool.usage["output"],
            reasoning_tokens=delegate_tool.usage["reasoning"],
            cache_hit_tokens=delegate_tool.usage["cache_hit"],
            cache_miss_tokens=delegate_tool.usage["cache_miss"],
        )
        finish = (
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
        cost_runs = [asdict(captain_cost), *(asdict(r) for r in delegate_tool.run_ledger)]
        turn_cost = aggregate_cost(cost_runs)

        # Fold the delegated workers' web sources into the turn's shared card
        # (deduped/capped against the CEO's own searches). The CEO collected its
        # sources live during the loop (numbered + cited inline); workers collected
        # theirs un-numbered, so appending them here keeps the CEO's [n] stable and
        # still surfaces the WHOLE team's research to the user. Mirrors how worker
        # usage/cost are folded back off the delegate tool instance above.
        merge_citations(citations, delegate_tool.citations)

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

        # Multi-agent execution journal (the turn's ordered run/tool events) for
        # persistence + later replay; None unless the CEO delegated (no team =
        # no runs payload). Mirrors how citations are carried back on the result.
        journal = sink.execution_journal()
        runs = {"events": journal, "finish_reason": finish.value} if journal else None

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

    except Exception as e:
        logger.error("pipeline_error", error=str(e), exc_info=True)
        sink.emit(error_event("PIPELINE_ERROR", str(e)))
        sink.emit(message_end(FinishReason.ERROR))
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "finish_reason": FinishReason.ERROR,
        }
    finally:
        sink.close()
        with contextlib.suppress(Exception):
            await llm.close()
