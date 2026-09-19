"""Ordinary ask_user pauses are ``decision``."""

from __future__ import annotations

from typing import TYPE_CHECKING

from agentcore.runtime.checkpoints import AskCheckpointIntent

if TYPE_CHECKING:
    from agentcore.llm.provider.protocol import LLMMessage


def resolve_ask_checkpoint_intent(
    transcript: list[LLMMessage] | None = None,
) -> AskCheckpointIntent:
    """Classify a blocking ``ask_user`` pause for the ``checkpoint_required`` payload.

    Ordinary clarifying asks are always ``decision``.
    """
    _ = transcript
    return "decision"
