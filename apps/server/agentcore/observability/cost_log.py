"""Emit ``cost.recorded`` after a turn's ledger rows persist.

The event lives in ``observability.catalog``; this module is the shared emit
path (cloud finalize, handoff persist, interrupt reconcile). Keep it out of
``agentcore.costing`` (stdlib-only shape; ``db`` depends on it) and out of
``conversation.common`` (runtime must not import that helpers module).
"""

from __future__ import annotations

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


def log_cost_recorded(conversation_id: str, message_id: str | None, cost_runs: list[dict]) -> None:
    """Emit ``cost.recorded`` after a turn's ledger rows persist successfully.

    ``by_role`` breaks spend by structural role (captain / member / vision / …)
    so ``log_stats`` and timeline triage can split team burn without joining DB.
    """
    total_nano = sum(int(r.get("cost_total_nano", 0) or 0) for r in cost_runs)
    models = sorted({str(r.get("model", "?")) for r in cost_runs if r.get("model")})
    by_role: dict[str, dict[str, int]] = {}
    for row in cost_runs:
        role = str(row.get("role") or "?")
        bucket = by_role.setdefault(role, {"runs": 0, "total_nano": 0, "input": 0, "output": 0})
        bucket["runs"] += 1
        bucket["total_nano"] += int(row.get("cost_total_nano", 0) or 0)
        tokens = row.get("tokens") or {}
        bucket["input"] += int(tokens.get("input", 0) or 0)
        bucket["output"] += int(tokens.get("output", 0) or 0)
    logger.info(
        "cost.recorded",
        conversation_id=conversation_id,
        message_id=message_id,
        runs=len(cost_runs),
        total_nano=total_nano,
        total_usd=round(total_nano / 1e9, 6),
        models=models,
        by_role=by_role,
    )
