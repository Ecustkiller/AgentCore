"""ChatPipeline: Prepare -> Execute -> Finalize.

Orchestrates a single user message through the full lifecycle:
  1. Prepare  — build context, resolve prompt/model/tools, load history
  2. Execute  — run ReAct loop, stream events
  3. Finalize — persist assistant message, update conversation
"""

import contextlib
import time
from dataclasses import asdict

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.config import get_profile
from agentcore.llm.factory import build_provider
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.memory import default_memory_store
from agentcore.runtime.approvals import ApprovalGate, default_approval_registry
from agentcore.runtime.costing import aggregate_cost, captain_run_cost
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    citations_event,
    message_end,
    message_start,
    run_completed,
    run_plan,
    run_started,
)
from agentcore.runtime.prompt import (
    CHAT_CITATION_HINT,
    CHAT_TEAM_CAPABILITY_HINT,
    assemble_system_prompt,
)
from agentcore.runtime.workspace import summarize
from agentcore.tools.builtin import build_builtin_registry
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
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
) -> dict:
    """Run the full chat pipeline for a single user message.

    Returns a dict with final_content, usage, and metadata.
    The sink receives all SSE events during execution.
    """
    message_id = new_id()
    # The CEO's own run gets a synthetic root id (it is this pipeline's ReAct
    # loop, not a scheduled Run): it parents every delegated member's ledger row
    # and labels the captain row in the cost ledger.
    captain_run_id = new_id()
    # Phase B (D3): the CEO's post-delegation 「汇总」 is surfaced as its own run
    # node — a real, drillable 汇聚点 symmetric with the workers, replacing the
    # synthetic placeholder. Pre-allocated so the engine can stream the synthesis
    # round to it; only actually emitted (via begin_synthesis) if the CEO delegates
    # this turn, and kept cost-neutral (the spend stays on the captain row).
    synthesis_run_id = new_id()
    synthesis_agent_id = new_id()

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

        # --- Phase 2: Assemble the CEO chat agent's toolset (chat-first) ---
        # The CEO owns the conversation and replies directly. It carries the
        # built-in tools plus a single on-demand orchestration primitive,
        # ``delegate``, which spins up a worker team ONLY when the model judges a
        # request truly needs one. There is no mandatory pre-turn orchestrator
        # pass — the CEO itself decides when/at what granularity to delegate.
        # ``delegate`` is NON-terminal: workers' products return to the CEO's own
        # ReAct loop, which writes a short user-facing overview in its own voice
        # (D3 / 决策①: per-worker detail is shown separately in the UI).
        # Workers get ``worker_tools`` (no nested delegate tool), so a worker can
        # never recursively delegate another team.
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
        )
        chat_tools = ToolRegistry()
        for schema in worker_tools.list_all():
            chat_tools.register(worker_tools.get(schema.name))
        chat_tools.register(delegate_tool)

        # The entry chat agent additionally learns it may escalate to a team and
        # how to cite web sources inline (single-agent path only — see prompt.py).
        chat_system_prompt = (
            f"{system_prompt}\n{CHAT_TEAM_CAPABILITY_HINT}\n{CHAT_CITATION_HINT}"
        )

        # --- Phase 3: Execute ---
        sink.emit(message_start(message_id, conversation_id=conversation_id))

        messages: list[LLMMessage] = [LLMMessage(role="system", content=chat_system_prompt)]
        for msg in history:
            messages.append(LLMMessage(role=msg["role"], content=msg["content"]))
        messages.append(LLMMessage(role="user", content=user_message))

        profile = get_profile("chat")
        # Web sources the chat agent consults this turn (web_search / read_url),
        # aggregated + de-duped by the loop for source cards + persistence.
        citations: list[dict] = []
        # Approval gate (CEO chat path only). One gate per turn so an
        # "allow for the rest of this turn" grant is scoped to this message and
        # does not leak across turns. Delegated workers run un-gated (the gate is
        # not threaded into runs/executor.py) — see docs.
        approval_gate = (
            ApprovalGate(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_approval_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
            )
            if settings.approval_gate_enabled
            else None
        )
        # Synthesis run lifecycle (Phase B). The engine flips into synthesis mode
        # the first time the captain resumes after a non-terminal delegate and
        # calls this once — declaring a CEO roster card + a synthesis-kind run so
        # the graph gets a real 汇聚点. We close run_completed after the loop. The
        # synthesis spend is NOT priced here: it is part of the captain's own loop
        # usage (turn_usage below) and billed once on the captain row, so this node
        # carries zero cost/usage and never enters cost_runs (no double count).
        synthesis_started = False
        synthesis_start = 0.0

        def _begin_synthesis() -> None:
            nonlocal synthesis_started, synthesis_start
            if synthesis_started:
                return
            synthesis_started = True
            synthesis_start = time.monotonic()
            sink.emit(
                run_plan(
                    execution_id=base_tool_context.execution_id,
                    plan_type="multi_agent",
                    task_summary="",
                    agents=[
                        {
                            "id": synthesis_agent_id,
                            "role": "CEO",
                            "model_preference": "strong",
                            "thinking": profile.thinking,
                            "reasoning_effort": profile.reasoning_effort,
                        }
                    ],
                    runs=[
                        {
                            "id": synthesis_run_id,
                            "agent_id": synthesis_agent_id,
                            "task": "汇总团队产出",
                            "depends_on": [],
                            "kind": "synthesis",
                        }
                    ],
                )
            )
            sink.emit(run_started(synthesis_run_id, synthesis_agent_id, kind="synthesis"))

        captain_start = time.monotonic()
        final_content, final_reasoning, turn_usage, rounds = await react_loop(
            messages=messages,
            llm=llm,
            tools=chat_tools,
            sink=sink,
            tool_context=base_tool_context,
            profile=profile,
            citation_sink=citations,
            approval_gate=approval_gate,
            synthesis_run_id=synthesis_run_id,
            synthesis_agent_id=synthesis_agent_id,
            begin_synthesis=_begin_synthesis,
        )
        captain_duration_ms = int((time.monotonic() - captain_start) * 1000)
        # Close the synthesis node (if the CEO delegated). Cost-neutral by design:
        # output_summary labels the collapsed node; usage/cost stay at the zeroed
        # default (rendered as「—」), since the spend is on the captain row.
        if synthesis_started:
            synth_duration_ms = int((time.monotonic() - synthesis_start) * 1000)
            sink.emit(
                run_completed(
                    synthesis_run_id,
                    synthesis_agent_id,
                    output_summary=summarize(final_content),
                    duration_ms=synth_duration_ms,
                    role="captain",
                    model=profile.model,
                )
            )
        # The CEO's own spend, captured before folding in the delegated workers
        # (they get their own per-member ledger rows). This is the captain root
        # run's usage for the cost ledger.
        captain_usage = turn_usage
        # ``delegate`` is non-terminal, so the loop does not meter its workers'
        # tokens (only terminal handoffs fold ToolResult metadata into the
        # totals). Add the delegated worker usage accumulated on the tool
        # instance across every delegate call this turn (cache split included so
        # the turn total stays priceable).
        turn_usage = turn_usage + TokenUsage(
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
        # The captain is this loop itself, priced here from its own usage; the
        # members were priced onto their RunState in the executor and collected on
        # the delegate tool. Built before message_end so the turn total can ride
        # on it (回合总账实时); the service then attaches the user/conversation/
        # message envelope and persists the rows (warning-only on failure).
        captain_cost = captain_run_cost(
            run_id=captain_run_id,
            model=profile.model,
            usage=captain_usage,
            rounds=rounds,
            duration_ms=captain_duration_ms,
        )
        cost_runs = [asdict(captain_cost), *(asdict(r) for r in delegate_tool.run_ledger)]
        turn_cost = aggregate_cost(cost_runs)

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
        from agentcore.runtime.events import error_event

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
