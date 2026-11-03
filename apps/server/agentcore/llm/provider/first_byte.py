"""First-byte deadline for a streamed turn — opt-in, off by default.

The engine already owns a stall gate: ``engine_llm_stream_idle_timeout_seconds``
(default 100s) wraps one streamed round in ``asyncio.timeout`` and reschedules on
progress chunks, so the wait before the first token *is* covered — one number for
both waits. That number is calibrated from both directions, and its comment says
so: below the leaf's 300s per-chunk read timeout, and **above worst-case
time-to-first-token on a large prompt** so a big finalization call is not
false-killed.

This module exists to split that single number in two, and it therefore ships
**disabled**. A shorter first wait is only safe where first tokens are measured
fast — a lane with sub-second TTFT can afford 60s and gains a fast, specific
failure; a lane serving 100k-token prefills cannot, and a cheap constant would
false-kill it. Turning it on is a deployment decision, not a default:

    AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS=60

What it adds when on is diagnosis, not just speed: the engine's gate reports one
stall for two different situations, so a turn that never started and a turn that
died mid-stream read the same. Expiry here is deliberately *not* a network error
either — the connection was fine and the upstream simply produced nothing, so the
copy says that instead of telling the user to check their network.

The guard wraps the SSE **line** iterator rather than timing the whole stream,
because "the model started" is a parsed payload line, not a byte. A stream that
opens with a role-only chunk and then goes quiet has not started, and treating
it as started is exactly how a hung turn hides behind an HTTP 200.

Wire readers are passed in (``openai_chat_payload_line`` /
``anthropic_payload_line``) so each leaf keeps its own idea of a first token
without this module knowing either protocol's chunk shape.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import AsyncIterator, Callable

# Shipped off — see the module docstring. ``engine_llm_stream_idle_timeout_seconds``
# is the gate that actually runs by default.
DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS: float | None = None
_FIRST_BYTE_TIMEOUT_ENV = "AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS"


def first_byte_timeout_seconds() -> float | None:
    """Budget for the wait before a stream's first token. ``None`` = no deadline.

    ``0`` (or negative) keeps it off. Env override is for dogfood, not a product
    setting — the copy still reads whatever value was in force.
    """
    raw = os.environ.get(_FIRST_BYTE_TIMEOUT_ENV, "").strip()
    if not raw:
        return DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS
    if value <= 0.0:
        return None
    return value


class FirstByteTimeoutError(Exception):
    """No parsed payload arrived inside the first-byte budget.

    Not an ``httpx`` error and not an ``LLMError``: the leaf catches it where it
    catches transport timeouts and mints its own product copy, so the bubble
    never claims the network failed when it did not.
    """

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        super().__init__(f"no first byte within {seconds:.0f}s")


async def lines_until_first_byte(
    source: AsyncIterator[str],
    *,
    budget_seconds: float | None,
    started_at: float,
    is_payload: Callable[[str], bool],
    clock: Callable[[], float] = time.monotonic,
) -> AsyncIterator[str]:
    """Yield ``source``'s lines, enforcing a deadline until the first payload.

    The budget covers everything from ``started_at`` (the moment the attempt
    began, so it includes waiting for the response head) to the first line that
    ``is_payload`` accepts. After that it is inert — the idle ceiling owns the
    rest of the stream.

    Cancelling the in-flight ``__anext__`` is safe here: expiry means the attempt
    is being abandoned, and the caller's ``async with`` closes the response.
    """
    iterator = source.__aiter__()
    remaining_budget = budget_seconds
    while True:
        if remaining_budget is None:
            try:
                line = await iterator.__anext__()
            except StopAsyncIteration:
                return
        else:
            left = (started_at + remaining_budget) - clock()
            if left <= 0:
                raise FirstByteTimeoutError(remaining_budget)
            try:
                line = await asyncio.wait_for(iterator.__anext__(), timeout=left)
            except TimeoutError as exc:
                raise FirstByteTimeoutError(remaining_budget) from exc
            except StopAsyncIteration:
                return
        if remaining_budget is not None and is_payload(line):
            remaining_budget = None
        yield line


def _sse_payload(line: str) -> dict | None:
    """The JSON object on an SSE ``data:`` line, or ``None`` when it carries none."""
    if not line.startswith("data: "):
        return None
    body = line[6:].strip()
    if not body or body == "[DONE]":
        return None
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def openai_chat_payload_line(line: str) -> bool:
    """True once a chat-completions delta carries content, reasoning, or a tool call.

    An empty ``delta: {}`` / role-only frame is a heartbeat: the provider has the
    request and has still produced nothing, which is what the deadline exists to
    catch.
    """
    payload = _sse_payload(line)
    if payload is None:
        return False
    choices = payload.get("choices")
    if not isinstance(choices, list):
        return False
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        if delta.get("content") or delta.get("reasoning_content"):
            return True
        if delta.get("reasoning"):
            return True
        if delta.get("tool_calls"):
            return True
    return False


def anthropic_payload_line(line: str) -> bool:
    """True once a Messages stream opens a content block.

    ``message_start`` / ``ping`` / ``message_delta`` do not count — a stream that
    says hello and then stalls has produced no answer.
    """
    payload = _sse_payload(line)
    if payload is None:
        return False
    return payload.get("type") in ("content_block_start", "content_block_delta")
