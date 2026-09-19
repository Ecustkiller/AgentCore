"""VisionReader port — unused by the live turn (native multimodal on main).

Kept so historical tests and the unused factory still compile. Images in
conversation attachments and workspace rasters go to the current main model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from agentcore.llm.provider.protocol import TokenUsage


@dataclass(frozen=True)
class VisionReading:
    """A vision model's reading of a PNG + the usage to bill it.

    ``text`` is the reading the CEO reasons over (``read_image`` / attachment
    eye→text). ``usage`` / ``model`` carry the sub-call's token cost so the caller
    can price it into the turn's ``cost_events`` ledger — the vision model is
    SEPARATE from the run's chat model, so its spend is its own priced ledger
    row, never folded into the run's usage. A reader with no usage signal (a
    stub) leaves ``usage`` zero, and the caller then bills nothing.
    """

    text: str
    usage: TokenUsage = field(default_factory=TokenUsage)
    model: str = ""


@runtime_checkable
class VisionReader(Protocol):
    """Reads an image (PNG, base64) and returns a :class:`VisionReading`."""

    async def read(self, png_base64: str, prompt: str) -> VisionReading:
        """Return a :class:`VisionReading` of ``png_base64`` guided by ``prompt``."""
        ...
