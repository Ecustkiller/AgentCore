"""Citation sink / evidence-ledger side-effects after a parallel tool round."""

from __future__ import annotations

from typing import Any

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.citations import (
    annotate_ledger_ids,
    annotate_tool_citations,
    merge_citations,
    normalize_citation_url,
)
from agentcore.runtime.events import EventSink
from agentcore.runtime.evidence_ledger import EvidenceLedgerCore
from agentcore.runtime.ledger_channel import emit_ledger_delta
from agentcore.runtime.loop_controller import ToolAttempt
from agentcore.tools.protocol import ToolResult


async def _register_message_citations(
    ledger: EvidenceLedgerCore,
    citations: list[dict[str, Any]],
    *,
    registrant: str,
) -> dict[str, str]:
    """向回合共享台账登记本条工具结果的来源；返回 ``{归一化url: #rN}``。"""
    id_map: dict[str, str] = {}
    for c in citations:
        eid = await ledger.register_citation(c, registrant=registrant)
        if eid is None:
            continue
        key = normalize_citation_url(str(c.get("url") or ""))
        if key:
            id_map[key] = eid
    return id_map


async def apply_round_citation_side_effects(
    quads: list[tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]],
    *,
    sink: EventSink,
    citation_sink: list[dict[str, Any]] | None,
    turn_evidence_ledger: EvidenceLedgerCore | None,
    ledger_registrant: str,
    annotate_citations: bool,
) -> None:
    """Merge web sources into mid-turn sink / ledger and annotate tool messages.

    P2：用户可见卡由 settle 按 ``cited_ids`` 投影，不在此发射 ``citations_event``。
    """
    if citation_sink is None and turn_evidence_ledger is None:
        return
    for message, _terminal, _attempt, message_citations in quads:
        if not message_citations:
            continue
        if citation_sink is not None:
            numbers = merge_citations(citation_sink, message_citations)
        else:
            numbers = {}
        if turn_evidence_ledger is not None and ledger_registrant:
            id_map = await _register_message_citations(
                turn_evidence_ledger,
                message_citations,
                registrant=ledger_registrant,
            )
            message.content = annotate_ledger_ids(
                message.content or "", message_citations, id_map
            )
        elif annotate_citations:
            message.content = annotate_tool_citations(
                message.content or "", message_citations, numbers
            )
    # Live 台账增量：本轮登记后 drain → 独立通道（不占 citations_event）。
    if turn_evidence_ledger is not None:
        emit_ledger_delta(sink, turn_evidence_ledger)
