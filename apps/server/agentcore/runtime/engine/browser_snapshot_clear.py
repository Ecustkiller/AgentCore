"""回合内 browser 大树投影：折叠旧 snapshot 的 elements / accessibility_tree。

Within one ReAct turn, repeated ``browser_snapshot`` (and any ``browser_*`` result whose
``untrusted_web_content`` carries an elements list or accessibility tree) re-pays those
large trees every round. This module keeps only the most recent ``keep_recent`` results
verbatim and strips the bulky tree fields from older ones — a PURE projection at
request-assembly time (``build_request_window``), like ``tool_clear`` / ``write_args_clear``.

Canonical ``messages`` / Turn Journal keep the full output; resume rebuilds then
re-applies. Prefix-cache safe: the omitted stub is a pure function of the original
JSON (stable ``sort_keys`` dump), so once a result falls out of the keep-window its
bytes stay fixed across rounds.
"""

from __future__ import annotations

import json

from agentcore.llm.provider.protocol import LLMMessage, llm_content_text

_TREE_KEYS = ("elements", "accessibility_tree")


def _call_info_map(messages: list[LLMMessage]) -> dict[str, tuple[str, str]]:
    call_info: dict[str, tuple[str, str]] = {}
    for message in messages:
        if message.role == "assistant" and message.tool_calls:
            for call in message.tool_calls:
                call_info[call.id] = (call.function.name, call.function.arguments or "")
    return call_info


def _parse_payload(content: str | None) -> dict | None:
    if not content:
        return None
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def has_browser_tree_fields(content: str | None) -> bool:
    """True when tool output JSON carries elements and/or accessibility_tree."""
    data = _parse_payload(content)
    if data is None:
        return False
    uw = data.get("untrusted_web_content")
    if not isinstance(uw, dict):
        return False
    return any(key in uw for key in _TREE_KEYS)


def omit_browser_tree_fields(content: str) -> str:
    """Strip tree fields and mark ``omitted: true``; stable for the same original.

    Preserves small payload fields (action / final_url / snapshot_version / keyframe / …)
    and non-tree ``untrusted_web_content`` keys (source_url / title / note / …).
    """
    data = _parse_payload(content)
    if data is None:
        return content
    uw = data.get("untrusted_web_content")
    if isinstance(uw, dict):
        for key in _TREE_KEYS:
            uw.pop(key, None)
        uw["omitted"] = True
    # sort_keys → byte-stable across rounds for the same original payload.
    return json.dumps(data, ensure_ascii=False, sort_keys=True)


def project_omitted_browser_snapshots(
    messages: list[LLMMessage],
    *,
    keep_recent: int = 1,
) -> list[LLMMessage]:
    """Keep the newest ``keep_recent`` browser tree results; omit trees on older ones.

    Candidates: ``browser_*`` tool results whose output JSON contains ``elements`` or
    ``accessibility_tree`` under ``untrusted_web_content`` (typically ``browser_snapshot``).

    Returns the same list object when nothing qualifies. Idempotent: already-omitted
    stubs lack tree keys and are never re-selected.
    """
    if keep_recent < 0:
        return messages

    call_info = _call_info_map(messages)
    tree_indices: list[int] = []
    for index, message in enumerate(messages):
        if message.role != "tool" or message.tool_call_id is None:
            continue
        info = call_info.get(message.tool_call_id)
        if info is None:
            continue
        name, _arguments = info
        if not name.startswith("browser_"):
            continue
        if not has_browser_tree_fields(llm_content_text(message.content)):
            continue
        tree_indices.append(index)

    if len(tree_indices) <= keep_recent:
        return messages

    to_omit = set(tree_indices[: len(tree_indices) - keep_recent])
    projected: list[LLMMessage] = []
    for index, message in enumerate(messages):
        if index in to_omit:
            projected.append(
                LLMMessage(
                    role="tool",
                    content=omit_browser_tree_fields(llm_content_text(message.content)),
                    tool_call_id=message.tool_call_id,
                )
            )
        else:
            projected.append(message)
    return projected
