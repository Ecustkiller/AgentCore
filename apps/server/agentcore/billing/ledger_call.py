"""Shared priced ``CallCost`` assembly for both ledger enqueue surfaces.

In-process cloud metering (``call_meter`` → ``source=inprocess_call``) and
inference proxy spend (``proxy_spend_queue`` → ``source=proxy_spend``) keep
separate outbox entrypoints for deployment shape, but must price and stamp
the same detail fields (tokens / cache split / role·persona attribution /
credential-sourced money columns). All field assembly lives here so a change
cannot land on one path and drift on the other.

Does **not** unify rate limits or ``preflight_llm_credentials`` (already
shared) and is **not** an ``LLMService`` facade.
"""

from __future__ import annotations

from typing import cast

from agentcore.billing.attribution import resolve_ledger_role
from agentcore.costing import CallCost
from agentcore.llm.pricing import CredentialSource, resolve_credential_source
from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.costing import priced_call_cost


def assemble_ledger_call(
    *,
    model: str,
    usage: TokenUsage,
    role: str | None = None,
    run_id: str | None = None,
    parent_run_id: str | None = None,
    agent_id: str | None = None,
    persona: str | None = None,
    call_id: str | None = None,
    duration_ms: int = 0,
    credential_source: str | None = None,
    platform_credential_id: str | None = None,
) -> CallCost:
    """Price one LLM call into a ``cost_calls`` detail row (shared by both paths).

    Resolves credential source + structural role, then delegates money/token
    reshape to :func:`~agentcore.runtime.costing.priced_call_cost` (不变量 #2).
    """
    explicit: CredentialSource | None = (
        cast(CredentialSource, credential_source)
        if credential_source in ("user", "platform", "vendor")
        else None
    )
    source = resolve_credential_source(credential_source=explicit, model=model)
    return priced_call_cost(
        model=model or "",
        usage=usage,
        role=resolve_ledger_role(role=role, agent_id=agent_id, run_id=run_id),
        run_id=run_id,
        parent_run_id=parent_run_id,
        agent_id=agent_id,
        persona=persona,
        call_id=call_id,
        duration_ms=duration_ms,
        credential_source=source,
        platform_credential_id=platform_credential_id,
    )
