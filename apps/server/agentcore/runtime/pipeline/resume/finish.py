"""Bill and close a resumed turn after settlement."""

from __future__ import annotations

from dataclasses import asdict

from agentcore.core.logging import get_logger
from agentcore.llm.protocol import TokenUsage
from agentcore.runtime.citations import merge_citations, out_of_range_markers
from agentcore.runtime.costing import aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.engine import join_segments
from agentcore.runtime.events import EventSink, FinishReason, citations_event, message_end
from agentcore.runtime.pipeline.finalize import _journal_entries_for_turn
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.revise import ReviseTool

logger = get_logger(__name__)


def finish_resume_turn(
    *,
    message_id: str,
    captain_run_id: str,
    captain_state,
    pre_pause_content: str,
    delegate_tool: DelegateTool,
    revise_tool: ReviseTool,
    debate_tool: DebateTool,
    profile,
    citations: list[dict],
    sink: EventSink,
    vision_cost_runs: list | None = None,
) -> dict:
    """Bill + close a resumed turn whose CEO loop ran (plan_review / ask_user continue).

    The whole turn bills once here: the captain's resume round + any delegated
    workers' usage (seeds + tail, folded by ``resume_plan``) + any revise. Mirrors
    :func:`run_chat_pipeline`'s tail (usage roll-up, per-run ledger, citations,
    message_end), returning the same result shape for the service to persist.

    ``vision_cost_runs`` are the resumed turn's board_read 读图 ledger rows (role=vision,
    §九.4 Gap ②), collected off the shared ``ToolContext.cost_sink``. Folded into
    ``cost_runs`` like the delegate / revise rows; vision spend has no usage that rolls
    into ``turn_usage`` (a separate model, billed only as its own priced row).
    """
    final_content = join_segments(pre_pause_content, captain_state.content)
    final_reasoning = captain_state.reasoning
    rounds = captain_state.rounds
    turn_usage = (
        TokenUsage.from_usage_dict(captain_state.usage)
        + TokenUsage.from_usage_dict(delegate_tool.usage)
        + TokenUsage.from_usage_dict(revise_tool.usage)
        + TokenUsage.from_usage_dict(debate_tool.usage)
    )
    finish = captain_state.finish_override or (
        FinishReason.END_TURN if rounds < profile.max_rounds else FinishReason.MAX_ROUNDS
    )
    captain_cost = captain_run_cost_from_state(captain_run_id, captain_state)
    cost_runs = [
        asdict(captain_cost),
        *(asdict(r) for r in delegate_tool.run_ledger),
        *(asdict(r) for r in revise_tool.run_ledger),
        *(asdict(r) for r in debate_tool.run_ledger),
        # board_read 视觉子调用账（§九.4 Gap ②），与 delegate/revise 同形折账。
        *(asdict(r) for r in (vision_cost_runs or [])),
    ]
    turn_cost = aggregate_cost(cost_runs)
    merge_citations(citations, delegate_tool.citations)
    merge_citations(citations, revise_tool.citations)
    merge_citations(citations, debate_tool.citations)
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
    journal_entries = _journal_entries_for_turn(None, sink=sink, finish=finish)
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
        # 协作质量 (学·度量 §2.5): same turn-level signals as the fresh-turn path.
        "collab": {
            **delegate_tool.collab,
            "revises": len(revise_tool.run_ledger),
        },
    }


def finish_terminal_resume(
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
    journal_entries = _journal_entries_for_turn(None, sink=sink, finish=finish)
    return {
        "message_id": message_id,
        "content": join_segments(pre_pause_content, closing),
        "reasoning_content": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cache_hit_tokens": 0,
        "cache_miss_tokens": 0,
        "rounds": 0,
        "finish_reason": finish,
        "citations": [],
        "cost_runs": [],
        "journal_entries": journal_entries,
    }
