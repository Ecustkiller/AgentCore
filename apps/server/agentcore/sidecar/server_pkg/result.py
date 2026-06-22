"""Sidecar turn result projection helpers."""

from typing import Any

from agentcore.runtime.checkpoints import CheckpointDecision


def parse_decision(raw: Any) -> CheckpointDecision:
    """Coerce the desktop's decision string into a :class:`CheckpointDecision`.

    The client only ever sends continue / adjust / stop (timeout is engine-set); an
    unknown / missing value defaults to ``CONTINUE`` (proceed) — the safe resume that
    runs the gated downstream as-is rather than dropping work.
    """
    try:
        return CheckpointDecision(str(raw or "").strip())
    except ValueError:
        return CheckpointDecision.CONTINUE


def trim_result(turn_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Project ``run_chat_pipeline``'s result into the JSON-safe startTurn response.

    The live events already carried the streaming detail; the response needs the
    final answer + totals for the bubble, plus the artifacts the desktop relays to
    the cloud for persistence (双模式工作区 §一.1 回写): the assistant ``citations`` and
    the replay ``runs`` payload (team graph / 思考·工具 timeline). Spend is NOT relayed —
    it's metered authoritatively at the cloud inference proxy (Slice 4a), not from the
    client. ``finish_reason`` is a ``FinishReason`` enum, coerced to its string value here.
    """
    finish = result.get("finish_reason")
    finish_str = finish.value if hasattr(finish, "value") else (str(finish) if finish else "error")
    return {
        "turnId": turn_id,
        "messageId": result.get("message_id"),
        "content": result.get("content", "") or "",
        "reasoningContent": result.get("reasoning_content"),
        "finishReason": finish_str,
        "rounds": int(result.get("rounds", 0) or 0),
        "usage": {
            "inputTokens": int(result.get("input_tokens", 0) or 0),
            "outputTokens": int(result.get("output_tokens", 0) or 0),
            "reasoningTokens": int(result.get("reasoning_tokens", 0) or 0),
        },
        # Persistence artifacts the desktop forwards to ``POST .../local-turns`` so a
        # sidecar turn lands in durable history exactly like a cloud turn (the renderer
        # relays them verbatim). Spend is metered at the cloud inference proxy (Slice 4a),
        # not relayed from here.
        "citations": result.get("citations") or [],
        "runs": result.get("runs"),
        "error": result.get("error"),
    }
