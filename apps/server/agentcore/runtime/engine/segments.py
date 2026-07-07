"""Text accumulation helpers for multi-round ReAct output."""

from typing import Any

from agentcore.llm.provider.protocol import ToolCall


def tool_calls_to_dicts(tool_calls: list[ToolCall] | None) -> list[dict[str, Any]]:
    """Serialize a round's tool calls for the ``llm_call`` fact (§8.3).

    The window fold rebuilds the assistant message from this, so it mirrors the
    OpenAI/transcript shape (``runs.serialize._tool_call_to_dict``) exactly — id +
    type + function(name, arguments) — keeping the facts module free of an
    ``llm.protocol`` import on the read side.
    """
    if not tool_calls:
        return []
    return [
        {
            "id": tc.id,
            "type": tc.type,
            "function": {
                "name": tc.function.name,
                "arguments": tc.function.arguments,
            },
        }
        for tc in tool_calls
    ]


def join_segments(acc: str, new: str) -> str:
    """Append a round's text to the turn content as a separate paragraph.

    Each ReAct round is a distinct thought, and the model often calls a tool — even a
    turn-pausing ``ask_user`` — between rounds. Concatenating raw made a pre-tool
    lead-in (e.g. one ending in "：") run straight into the post-resume continuation in
    the flattened ``content`` (DB / LLM history / search preview). Insert a blank line
    between non-empty segments so they read as paragraphs. The live stream still emits
    raw deltas and the inline ask_user card rides the journal, so neither the live view
    nor the card position is affected.
    """
    if not acc:
        return new
    if not new:
        return acc
    if acc[-1].isspace():
        return acc + new
    return f"{acc}\n\n{new}"
