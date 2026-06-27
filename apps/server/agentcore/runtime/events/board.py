"""AI 协作白板 (whiteboard) SSE event factories.

``board_op_required`` is the board counterpart of ``workspace_op_required``: a
transport-only client-tool request the server emits so the bound desktop applies a
batch of structured ops to the open Excalidraw canvas and POSTs the result back to
the ops-resolve endpoint (settling the suspended :class:`BoardChannel` future). It
carries the target ``board_id`` plus the op batch; the desktop converts ops → scene
elements, applies + autosaves, and returns created ids / the new version.
"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.types import EventType, SSEEvent


def board_op_required(
    *,
    request_id: str,
    conversation_id: str,
    board_id: str,
    ops: list[dict[str, Any]],
    summary: str = "",
) -> SSEEvent:
    return SSEEvent(
        type=EventType.BOARD_OP_REQUIRED,
        payload={
            "request_id": request_id,
            "conversation_id": conversation_id,
            "board_id": board_id,
            "ops": ops,
            "summary": summary,
        },
    )
