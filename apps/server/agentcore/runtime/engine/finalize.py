"""Forced tool-free finalization when governance trips or rounds exhaust."""

from collections.abc import Callable

from agentcore.core.logging import get_logger
from agentcore.llm.config import ModelProfile, build_request
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.facts import NoteFact, record_turn_fact

from .constants import FINALIZE_INSTRUCTION
from .segments import join_segments
from .stream import stream_llm_round

logger = get_logger(__name__)


async def force_finalize(
    *,
    messages: list[LLMMessage],
    llm: DeepSeekProvider,
    profile: ModelProfile,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    final_content: str,
    final_reasoning: str,
    total_usage: TokenUsage,
    rounds: int,
    reason: str,
    run_id: str = "",
) -> tuple[str, str, TokenUsage, int]:
    """Force one tool-free LLM round to guarantee a real textual answer.

    Disables tools (``tool_choice="none"``) so the model must produce text. Used
    when convergence governance trips a hard finalize and when the round budget
    is exhausted mid-tool-call. Best-effort: on failure it returns whatever
    content was already accumulated rather than raising.
    """
    messages.append(LLMMessage(role="user", content=FINALIZE_INSTRUCTION))
    # 执行级事件溯源 (§8.3): the forced-finalize instruction is injected into the real
    # LLM window, so the window fold needs it as a fact (no-op outside a turn). Scoped to
    # the calling run so the captain window picks it up even mid-delegate (边界②).
    record_turn_fact(
        NoteFact(
            role="user",
            content=FINALIZE_INSTRUCTION,
            reason="finalize",
            run_id=run_id,
        ).to_fact()
    )
    request = build_request(profile, messages, tools=None, tool_choice="none")
    try:
        content, reasoning, _tool_calls, usage = await stream_llm_round(
            llm, request, emit_content, emit_reasoning
        )
    except Exception as e:
        logger.error("engine.force_finalize_failed", reason=reason, error=str(e))
        return final_content, final_reasoning, total_usage, rounds

    if usage:
        total_usage = total_usage + usage

    combined_content = join_segments(final_content, content)
    combined_reasoning = f"{final_reasoning}{reasoning}" if final_reasoning else reasoning
    return combined_content, combined_reasoning, total_usage, rounds
