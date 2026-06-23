"""回合内工具结果清理 (clear_tool_uses): collapse OLD re-fetchable tool results.

Within one ReAct run a long worker re-reads many files / pages; every round re-sends
all of those tool results to the model, paying their tokens again and burying the
recent signal under stale reads (context rot). This module collapses the OLD,
read-only, re-fetchable results into a compact, stable pointer so the model still
knows the call happened (and can re-issue it) without carrying the full body.

Design — a PURE projection applied at request-assembly time only (``build_request``),
NOT a mutation of the canonical window:

- The canonical ``messages`` list AND the durable Turn Journal keep the FULL output.
  Resume rebuilds the full window via ``window_from_journal`` then runs the same
  ``react_loop``, so the projection re-applies and lands byte-for-byte on the live
  window — no journal change, no resume divergence. (执行引擎架构设计 §三)
- The UI is unaffected: tool results render from ``tool_use_end`` / the journal, not
  the cleared LLM window, so the user still sees full output. Clearing is invisible.
- Prefix-cache safe: a cleared result's pointer is a pure function of its own
  (tool, args, original length), so once a result falls out of the keep-window its
  pointer bytes are FIXED across rounds and stay at the same position. The cleared
  region therefore remains cache-hittable; only the moving boundary near the tail
  (which re-caches every round anyway) misses.

What is cleared = read-only re-fetchable tool results (the run's ``investigation_tools``
— NEVER-approval FILESYSTEM / SEARCH / RESEARCH) that have fallen out of the most
recent ``keep_recent`` window AND are at least ``min_chars`` long. Never cleared:
side-effecting / non-re-fetchable results (``code_execute`` / ``file_write`` / …),
interaction results, injected user steers (nudge / reflection / circuit breaker),
assistant / system messages.
"""

import json

from agentcore.llm.protocol import LLMMessage

# Argument keys, in priority order, that identify WHICH read-only call was cleared, so
# the pointer names the specific file / query / url and the model can re-issue it.
_HINT_KEYS = ("path", "file_path", "query", "url", "pattern")


def _key_arg(arguments: str) -> str:
    """A short ``key=value`` identifier for the cleared call's pointer.

    Best-effort and never raises: a non-JSON / unexpected argument shape yields an
    empty hint (the pointer then names just the tool).
    """
    try:
        data = json.loads(arguments) if arguments else {}
    except (json.JSONDecodeError, TypeError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    for key in _HINT_KEYS:
        value = data.get(key)
        if isinstance(value, str) and value:
            return f"{key}={value!r}"
    return ""


def cleared_placeholder(tool_name: str, arguments: str, original_len: int) -> str:
    """The stable pointer that replaces a cleared tool result's content.

    Deterministic in its inputs (no time / counters), so the same cleared result
    yields byte-identical bytes on every round — the prefix-cache invariant.
    """
    hint = _key_arg(arguments)
    head = f"{tool_name}({hint})" if hint else tool_name
    return (
        f"[已清理: {head} 的输出（{original_len} 字符）已从上下文窗口移除以节省 token；"
        "如仍需要可重新调用该工具获取。]"
    )


def project_cleared_window(
    messages: list[LLMMessage],
    *,
    clearable_tools: frozenset[str] | set[str],
    keep_recent: int,
    min_chars: int,
) -> list[LLMMessage]:
    """Return ``messages`` with old re-fetchable tool results collapsed to pointers.

    Returns the SAME list object unchanged when nothing qualifies (a short turn with
    few reads never triggers clearing), so callers can cheaply detect a no-op with
    ``result is messages``. Otherwise returns a new list; the kept messages are the
    same objects (only cleared ``tool`` messages are rebuilt), and structure is
    preserved (role / ``tool_call_id`` untouched) so the assistant↔tool pairing the
    OpenAI API requires never breaks.

    Idempotent: a pointer is below ``min_chars`` and so is never re-cleared, hence
    ``project(project(x)) == project(x)``.
    """
    if not clearable_tools or keep_recent < 0:
        return messages

    # tool_call_id → (tool_name, arguments), from the assistant messages that issued
    # the calls — lets us decide clearability and build a re-fetch hint without the
    # executor's state.
    call_info: dict[str, tuple[str, str]] = {}
    for message in messages:
        if message.role == "assistant" and message.tool_calls:
            for call in message.tool_calls:
                call_info[call.id] = (call.function.name, call.function.arguments or "")

    # Positions of clearable tool results (read-only tool + large enough), in order.
    clearable_indices: list[int] = []
    for index, message in enumerate(messages):
        if message.role != "tool" or message.tool_call_id is None:
            continue
        info = call_info.get(message.tool_call_id)
        if info is None:
            continue
        name, _arguments = info
        if name not in clearable_tools:
            continue
        if len(message.content or "") < min_chars:
            continue
        clearable_indices.append(index)

    # Keep the most recent ``keep_recent`` verbatim; clear everything older.
    if len(clearable_indices) <= keep_recent:
        return messages
    to_clear = set(clearable_indices[: len(clearable_indices) - keep_recent])

    projected: list[LLMMessage] = []
    for index, message in enumerate(messages):
        if index in to_clear:
            name, arguments = call_info[message.tool_call_id]  # present by construction
            projected.append(
                LLMMessage(
                    role="tool",
                    content=cleared_placeholder(name, arguments, len(message.content or "")),
                    tool_call_id=message.tool_call_id,
                )
            )
        else:
            projected.append(message)
    return projected
