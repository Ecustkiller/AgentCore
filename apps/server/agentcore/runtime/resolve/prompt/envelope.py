"""CEO per-turn user envelope — volatile facts outside ``role: system``.

Frozen constitution / identity / on-demand catalog stay in the system prompt.
Date, workspace (+ CEO file index), scene gates, attachments, table, and source
ledger ride a synthetic user message fenced with ``[系统提示]``. The envelope
is rebuilt each LLM call, snapshotted on ``turn_started``, and never persisted
as a conversation-history turn.
Workers keep date + workspace in system. Do not copy the CEO envelope onto
workers: their chain is run-scoped. Resume restamp of worker facts appends
``[系统提示]`` after history and never rewrites the emitted ``role: system``;
date stays in worker system; debate stays out. Tool-failure facts stay in
receipts / synthesis, not ``role: system``.
See docs/03-AI核心/执行引擎架构设计.md §七.
"""

from __future__ import annotations

from collections.abc import Sequence

from agentcore.config import settings
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.context import ContextAssembler, SectionOrder
from agentcore.runtime.context.workspace_overview import attach_workspace_file_index
from agentcore.runtime.resolve.prompt.base import render_runtime_date_block
from agentcore.runtime.resolve.prompt.ceo_core import _attachment_material_block

TURN_ENVELOPE_FENCE = "[系统提示]"


def strip_turn_envelope_fence(text: str) -> str:
    """Drop the leading fence line so XML tags remain for the context catalog."""
    raw = (text or "").strip()
    if not raw:
        return ""
    if raw.startswith(TURN_ENVELOPE_FENCE):
        rest = raw[len(TURN_ENVELOPE_FENCE) :].lstrip("\n")
        return rest.strip()
    return raw


def visualization_system_body(system: str, envelope: str) -> str:
    """Concatenate envelope XML into the system ContextBlock (no new SSE channel).

    The LLM still sees the envelope as a separate user message; the desktop
    「收到的上下文」reader indexes ``<工作区>`` from ``channel=system``.
    """
    xml = strip_turn_envelope_fence(envelope)
    frozen = (system or "").rstrip()
    if not xml:
        return frozen
    if not frozen:
        return xml
    return f"{frozen}\n\n{xml}"


def opening_ceo_messages(
    *,
    system_prompt: str,
    history: Sequence[LLMMessage] | Sequence[dict] | None,
    turn_envelope: str,
    user_content: str | list,
) -> list[LLMMessage]:
    """Captain opening window: system → history → envelope user → real user.

    Fold and the live executor must share this helper so pause conformance
    stays byte-identical.
    """
    messages = [LLMMessage(role="system", content=system_prompt)]
    for msg in history or []:
        if isinstance(msg, LLMMessage):
            messages.append(msg)
        else:
            messages.append(LLMMessage(role=msg["role"], content=msg["content"]))
    env = (turn_envelope or "").strip()
    if env:
        messages.append(LLMMessage(role="user", content=env))
    messages.append(LLMMessage(role="user", content=user_content))
    return messages


def render_ceo_turn_envelope(
    *,
    workspace_context: str | None = None,
    workspace_file_index: str | None = None,
    table_context: str | None = None,
    attachment_material: bool = False,
    attachment_context: str = "",
    registered_sources: str = "",
    soft_cap: int | None = None,
    include_runtime: bool = True,
) -> str:
    """Render the CEO's ephemeral ``[系统提示]`` user message (empty → ``""``)."""
    material_block = _attachment_material_block(attachment_material)
    cap = settings.prompt_budget_char_soft_cap if soft_cap is None else soft_cap
    body = (
        ContextAssembler()
        .add(
            "runtime_context",
            render_runtime_date_block() if include_runtime else None,
            SectionOrder.RUNTIME_CONTEXT,
        )
        .add(
            "workspace_facts",
            attach_workspace_file_index(
                workspace_context or "",
                workspace_file_index or "",
            )
            or None,
            SectionOrder.WORKSPACE_FACTS,
        )
        .add("attachment_material", material_block, SectionOrder.WORKING_SET)
        .add("attachment_context", attachment_context, SectionOrder.ATTACHMENT)
        .add("table_context", table_context, SectionOrder.TABLE_FACTS)
        .add("registered_sources", registered_sources, SectionOrder.REGISTERED_SOURCES)
        .observe(scope="ceo_envelope", soft_cap=cap)
        .render()
    )
    text = (body or "").strip()
    if not text:
        return ""
    return f"{TURN_ENVELOPE_FENCE}\n{text}"
