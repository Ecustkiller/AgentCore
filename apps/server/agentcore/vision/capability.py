"""Legacy capability bit — unused by the live turn (no ``read_image`` surface).

True when a :class:`~agentcore.vision.protocol.VisionReader` is wired **or** the
main chat model accepts images (:func:`~agentcore.llm.image_accept.model_accepts_images`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.vision.protocol import VisionReader


def vision_capability_available(
    *,
    vision_reader: VisionReader | None,
    main_native_vision: bool,
) -> bool:
    """True iff this turn can actually see images (reader or native multimodal)."""
    return vision_reader is not None or main_native_vision
