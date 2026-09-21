"""Sidecar turn result projection helpers."""

from typing import Any

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.journal import runs_from_entries


def parse_decision(raw: Any) -> CheckpointDecision:
    """Coerce the desktop's decision string into a :class:`CheckpointDecision`.

    The client only ever sends continue / adjust / stop (timeout is engine-set).
    Missing / blank defaults to ``CONTINUE``. Unknown values raise ``ValueError``.
    """
    text = str(raw or "").strip()
    if not text:
        return CheckpointDecision.CONTINUE
    try:
        return CheckpointDecision(text)
    except ValueError:
        raise ValueError("invalid decision") from None


def trim_result(turn_id: str, result: dict[str, Any], *, model: str) -> dict[str, Any]:
    """Project ``run_chat_pipeline``'s result into the JSON-safe startTurn response.

    The live events already carried the streaming detail; the response needs the
    final answer + totals for the bubble, plus the artifacts the desktop relays to
    the cloud for persistence (双模式工作区 §一.1 回写): the assistant ``citations`` and
    the replay ``runs`` payload (team graph / 思考·工具 timeline). Spend is NOT relayed —
    it's metered authoritatively at the cloud inference proxy (Slice 4a), not from the
    client. ``finish_reason`` is a ``FinishReason`` enum, coerced to its string value here.

    ``model`` is the chat model this turn ACTUALLY ran on (``resolve_turn_model`` over the
    turn's creds — the cloud-proxy/account model when a token was present). Surfaced so
    the desktop badge shows the honest per-turn model. Turns without inference are
    refused before the engine runs (``INFERENCE_TOKEN_EXPIRED``). Live token totals
    here are the startTurn RPC bubble; reload-visible ``Message.usage`` is the outbox
    settle snapshot (``USAGE_SETTLE_KEYS``), not this usage block.
    """
    finish = result.get("finish_reason")
    finish_str = finish.value if hasattr(finish, "value") else (str(finish) if finish else "error")
    journal_entries = result.get("journal_entries")
    runs = runs_from_entries(journal_entries) if journal_entries else None
    return {
        "turnId": turn_id,
        "messageId": result.get("message_id"),
        "content": result.get("content", "") or "",
        "reasoningContent": result.get("reasoning_content"),
        "finishReason": finish_str,
        "model": model,
        "rounds": int(result.get("rounds", 0) or 0),
        "usage": {
            "inputTokens": int(result.get("input_tokens", 0) or 0),
            "outputTokens": int(result.get("output_tokens", 0) or 0),
            "reasoningTokens": int(result.get("reasoning_tokens", 0) or 0),
            "cacheHitTokens": int(result.get("cache_hit_tokens", 0) or 0),
            "cacheMissTokens": int(result.get("cache_miss_tokens", 0) or 0),
        },
        "citations": result.get("citations") or [],
        "runs": runs,
        "error": result.get("error"),
    }
