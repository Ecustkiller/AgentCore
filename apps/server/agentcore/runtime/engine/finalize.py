"""Forced finalization when governance trips or rounds exhaust."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from agentcore.core.logging import get_logger
from agentcore.llm.profiles import ProfileParams, build_request
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage, ToolCall
from agentcore.runtime.facts import NoteFact, record_turn_fact
from agentcore.tools.registry import ToolRegistry

from .constants import FINALIZE_COORDINATION_TOOLS, FINALIZE_INSTRUCTION
from .governance import resolve_finalize_coordination_tools
from .segments import join_segments
from .stream import stream_llm_round

logger = get_logger(__name__)


@dataclass(frozen=True)
class FinalizeRoundResult:
    """Outcome of one forced-finalize LLM round."""

    kind: Literal["answer", "coordination_tools", "empty"]
    content: str
    reasoning: str
    usage: TokenUsage | None
    tool_calls: list[ToolCall] | None = None


def _record_finalize_instruction(*, run_id: str) -> None:
    record_turn_fact(
        NoteFact(
            role="user",
            content=FINALIZE_INSTRUCTION,
            reason="finalize",
            run_id=run_id,
        ).to_fact()
    )


async def run_finalize_round(
    *,
    messages: list[LLMMessage],
    llm: OpenAICompatibleProvider,
    profile: ProfileParams,
    active_model: str,
    tools: ToolRegistry,
    allowed_tool_names: list[str] | None,
    disabled_tools: set[str],
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    run_id: str = "",
    hard_tool_free: bool = False,
    inject_instruction: bool = True,
) -> FinalizeRoundResult:
    """One finalize LLM round: coordination tools only, or tool-free when ``hard_tool_free``."""
    if inject_instruction:
        messages.append(LLMMessage(role="user", content=FINALIZE_INSTRUCTION))
        _record_finalize_instruction(run_id=run_id)

    if hard_tool_free:
        tool_defs = None
        tool_choice = "none"
    else:
        tool_defs = resolve_finalize_coordination_tools(tools, allowed_tool_names, disabled_tools)
        tool_choice = "auto" if tool_defs else "none"

    request = build_request(
        profile, messages, tools=tool_defs, tool_choice=tool_choice, model=active_model
    )
    content, reasoning, tool_calls, usage, _diag, _preview = await stream_llm_round(
        llm, request, emit_content, emit_reasoning
    )

    if hard_tool_free and tool_calls:
        tool_calls = None

    if tool_calls:
        allowed = [tc for tc in tool_calls if tc.function.name in FINALIZE_COORDINATION_TOOLS]
        if allowed:
            return FinalizeRoundResult(
                kind="coordination_tools",
                content=content,
                reasoning=reasoning,
                usage=usage,
                tool_calls=allowed,
            )
        if content.strip():
            return FinalizeRoundResult(
                kind="answer",
                content=content,
                reasoning=reasoning,
                usage=usage,
            )
        return FinalizeRoundResult(
            kind="empty",
            content=content,
            reasoning=reasoning,
            usage=usage,
        )
    if content.strip():
        return FinalizeRoundResult(
            kind="answer",
            content=content,
            reasoning=reasoning,
            usage=usage,
        )
    return FinalizeRoundResult(
        kind="empty",
        content=content,
        reasoning=reasoning,
        usage=usage,
    )


async def force_finalize(
    *,
    messages: list[LLMMessage],
    llm: OpenAICompatibleProvider,
    profile: ProfileParams,
    active_model: str,
    tools: ToolRegistry,
    allowed_tool_names: list[str] | None,
    disabled_tools: set[str],
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    final_content: str,
    final_reasoning: str,
    total_usage: TokenUsage,
    rounds: int,
    reason: str,
    run_id: str = "",
) -> tuple[str, str, TokenUsage, int, FinalizeRoundResult | None]:
    """Attempt a coordination-tool finalize round, then fall back to tool-free.

    Returns ``(content, reasoning, usage, rounds, coordination_result)``.
    When ``coordination_result.kind == "coordination_tools"``, the caller must execute
    those tools and continue the loop instead of ending the turn.
    """
    try:
        soft = await run_finalize_round(
            messages=messages,
            llm=llm,
            profile=profile,
            active_model=active_model,
            tools=tools,
            allowed_tool_names=allowed_tool_names,
            disabled_tools=disabled_tools,
            emit_content=emit_content,
            emit_reasoning=emit_reasoning,
            run_id=run_id,
            hard_tool_free=False,
        )
    except Exception as e:
        logger.error("engine.force_finalize_failed", reason=reason, error=str(e))
        return final_content, final_reasoning, total_usage, rounds, None

    if soft.kind == "coordination_tools":
        if soft.usage:
            total_usage = total_usage + soft.usage
        return final_content, final_reasoning, total_usage, rounds, soft

    if soft.kind == "answer":
        if soft.usage:
            total_usage = total_usage + soft.usage
        combined_content = join_segments(final_content, soft.content)
        combined_reasoning = (
            f"{final_reasoning}{soft.reasoning}" if final_reasoning else soft.reasoning
        )
        return combined_content, combined_reasoning, total_usage, rounds, None

    # Empty soft round → hard tool-free fallback (instruction already injected once).
    try:
        hard = await run_finalize_round(
            messages=messages,
            llm=llm,
            profile=profile,
            active_model=active_model,
            tools=tools,
            allowed_tool_names=allowed_tool_names,
            disabled_tools=disabled_tools,
            emit_content=emit_content,
            emit_reasoning=emit_reasoning,
            run_id=run_id,
            hard_tool_free=True,
            inject_instruction=False,
        )
    except Exception as e:
        logger.error("engine.force_finalize_hard_failed", reason=reason, error=str(e))
        return final_content, final_reasoning, total_usage, rounds, None

    if hard.usage:
        total_usage = total_usage + hard.usage
    combined_content = join_segments(final_content, hard.content)
    combined_reasoning = (
        f"{final_reasoning}{hard.reasoning}" if final_reasoning else hard.reasoning
    )
    return combined_content, combined_reasoning, total_usage, rounds, None
