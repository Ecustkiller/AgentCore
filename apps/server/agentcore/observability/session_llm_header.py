"""Last successful CEO chat LLM header per conversation — compaction reuses it.

Window compact reuses the live ReAct ``tools`` + ``role: system`` + window.
Chat compact reuses the last ``chat`` header (system + tools + model) so the
summary call can share the same DeepSeek/Qoder prefix. Title / memory /
compaction / worker ``agent`` calls do not overwrite the header.

``pin_chat_system`` freezes node 0 from that header; later catalog/rules
updates append as in-history extra system (changed ``<设定>`` / ``<按需目录>``
blocks, or the full compose when the rest drifted) instead of rewriting
``messages[0]``.

The LRU dies with the process. Each successful chat turn stamps the header onto
the prompting user row (``usage.frozen_chat_system`` / ``chat_header_tools`` /
``chat_header_model``). REST UsageBreakdown strips those keys. After restart,
``hydrate_session_header`` reloads the newest stamp before pin / compaction.

``pin_chat_tools`` freezes the outgoing ``tools[]`` the same way: same names keep
the frozen schemas; membership change (MCP / ``host=off`` / git binary) is an
allowed header.change and sends the live table. Resume pins without that change.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from agentcore.llm.provider.protocol import llm_content_text
from agentcore.observability.prefix_cache import tools_fingerprint
from agentcore.runtime.resolve.prompt.in_history import in_history_system_delta

_MAX_HEADERS = 256
# Conversation compact reuses the CEO chat prefix. Worker ``agent`` calls must
# not overwrite it — otherwise the fold request ships the last worker's
# system+tools against chat history.
_PRODUCT_SCENARIOS = frozenset({"chat"})
# Prompting-user ``messages.usage`` keys. Unknown to UsageBreakdown — not bubble text.
FROZEN_CHAT_SYSTEM_USAGE_KEY = "frozen_chat_system"
CHAT_HEADER_TOOLS_USAGE_KEY = "chat_header_tools"
CHAT_HEADER_MODEL_USAGE_KEY = "chat_header_model"
_HARVEST_USER_ORIGIN = "execution_harvest"
_LOAD_RECENT = 64


@dataclass(frozen=True, slots=True)
class SessionLlmHeader:
    """Wire prefix of the last product call on this conversation."""

    system: str
    tools: tuple[Any, ...]
    model: str


_HEADERS: OrderedDict[str, SessionLlmHeader] = OrderedDict()


def record_session_header(
    *,
    conversation_id: str,
    scenario: str,
    model: str,
    messages: list[Any] | None,
    tools: list[dict[str, Any]] | None,
) -> None:
    """Keep the last CEO ``chat`` header. No-op for workers / background one-shots."""
    cid = (conversation_id or "").strip()
    if not cid or scenario not in _PRODUCT_SCENARIOS:
        return
    if not messages:
        return
    first = messages[0]
    if str(getattr(first, "role", "") or "") != "system":
        return
    system = llm_content_text(getattr(first, "content", None)).strip()
    if not system:
        return
    header = SessionLlmHeader(
        system=system,
        tools=tuple(tools or ()),
        model=(model or "").strip(),
    )
    _HEADERS.pop(cid, None)
    _HEADERS[cid] = header
    while len(_HEADERS) > _MAX_HEADERS:
        _HEADERS.popitem(last=False)


def get_session_header(conversation_id: str) -> SessionLlmHeader | None:
    cid = (conversation_id or "").strip()
    if not cid:
        return None
    return _HEADERS.get(cid)


def restore_session_header(conversation_id: str, header: SessionLlmHeader) -> None:
    """Put a loaded stamp back into the LRU. No-op on empty system."""
    cid = (conversation_id or "").strip()
    if not cid or not (header.system or "").strip():
        return
    _HEADERS.pop(cid, None)
    _HEADERS[cid] = header
    while len(_HEADERS) > _MAX_HEADERS:
        _HEADERS.popitem(last=False)


def header_from_usage(usage: dict[str, Any] | None) -> SessionLlmHeader | None:
    """Parse a prompting-user ``usage`` blob into a header, or ``None``."""
    if not isinstance(usage, dict):
        return None
    system = usage.get(FROZEN_CHAT_SYSTEM_USAGE_KEY)
    if not isinstance(system, str) or not system.strip():
        return None
    raw_tools = usage.get(CHAT_HEADER_TOOLS_USAGE_KEY)
    tools: tuple[Any, ...] = ()
    if isinstance(raw_tools, list):
        tools = tuple(item for item in raw_tools if isinstance(item, dict))
    model = usage.get(CHAT_HEADER_MODEL_USAGE_KEY)
    model_s = model.strip() if isinstance(model, str) else ""
    return SessionLlmHeader(system=system.strip(), tools=tools, model=model_s)


def header_to_usage(header: SessionLlmHeader) -> dict[str, Any]:
    """Usage keys to merge onto the prompting user row."""
    return {
        FROZEN_CHAT_SYSTEM_USAGE_KEY: header.system,
        CHAT_HEADER_TOOLS_USAGE_KEY: list(header.tools),
        CHAT_HEADER_MODEL_USAGE_KEY: header.model,
    }


def pin_chat_system(conversation_id: str, current: str) -> tuple[str, str]:
    """DeepSeek ``systemPromptUpdate: 'in-history'``.

    Return ``(messages[0] frozen system, extra system or empty)``. Never rewrite
    node 0 after the first recorded chat header. Extra is a catalog/rules delta
    when only those blocks moved; otherwise the full current compose. Callers
    hydrate from the user-row stamp before this when the process LRU is cold.
    """
    text = (current or "").strip()
    header = get_session_header(conversation_id)
    frozen = (header.system if header is not None else "") or text
    if not text or frozen == text:
        return frozen, ""
    return frozen, in_history_system_delta(frozen, text)


def _openai_tool_names(tools: Sequence[Any]) -> tuple[str, ...]:
    names: list[str] = []
    for item in tools:
        if not isinstance(item, dict):
            continue
        fn = item.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("name"), str) and fn["name"].strip():
            names.append(fn["name"])
        elif isinstance(item.get("name"), str) and item["name"].strip():
            names.append(item["name"])
    return tuple(names)


def pin_chat_tools(
    conversation_id: str,
    current: Sequence[dict[str, Any]] | None,
    *,
    allow_header_change: bool = True,
) -> list[dict[str, Any]]:
    """DeepSeek frozen ``tools[]``. Membership change may replace the table.

    Same names (schema prose drift after deploy) keep the frozen defs. Name-set
    or order change — MCP toggle, ``host=off``, git binary, new factory tool —
    sends ``current`` when ``allow_header_change`` (fresh chat). Resume passes
    ``False`` so a paused turn does not rewrite the wire table.
    """
    live = [item for item in (current or ()) if isinstance(item, dict)]
    header = get_session_header(conversation_id)
    frozen = [
        item
        for item in (header.tools if header is not None else ())
        if isinstance(item, dict)
    ]
    if not frozen:
        return live
    if not live:
        return frozen
    if tools_fingerprint(frozen) == tools_fingerprint(live):
        return frozen
    if _openai_tool_names(frozen) == _openai_tool_names(live):
        return frozen
    if allow_header_change:
        return live
    return frozen


async def load_stamped_session_header(conversation_id: str) -> SessionLlmHeader | None:
    """Newest prompting-user stamp for this conversation (own session)."""
    cid = (conversation_id or "").strip()
    if not cid:
        return None
    from agentcore.conversation.failure_visible import usage_of
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories import MessageRepository

    async with async_session_factory() as session:
        rows = await MessageRepository(session).list_recent(cid, limit=_LOAD_RECENT)
    for msg in reversed(list(rows)):
        if getattr(msg, "role", None) != "user":
            continue
        usage = usage_of(msg)
        if usage.get("origin") == _HARVEST_USER_ORIGIN:
            continue
        header = header_from_usage(usage)
        if header is not None:
            return header
    return None


async def hydrate_session_header(conversation_id: str) -> SessionLlmHeader | None:
    """LRU hit, else reload the user-row stamp. Never raises into the turn path."""
    existing = get_session_header(conversation_id)
    if existing is not None:
        return existing
    try:
        loaded = await load_stamped_session_header(conversation_id)
    except Exception:  # noqa: BLE001 — prefix-cache hydrate must never break the turn
        return None
    if loaded is not None:
        restore_session_header(conversation_id, loaded)
    return loaded


def reset_session_headers() -> None:
    """Test seam."""
    _HEADERS.clear()
