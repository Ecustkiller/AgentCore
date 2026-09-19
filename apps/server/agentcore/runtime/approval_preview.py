"""审批卡实名化：弹卡前把只有 id 的参数补成人能审的样子.

失败即放弃（fail-soft）：查不到补全就照原样弹卡，不要为了好看而挡住审批链。
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

_ENRICHERS: dict[str, Any] = {}


async def enrich_approval_preview(
    *, tool_name: str, arguments: Any, user_id: str
) -> Any:
    """Return ``arguments`` plus any authoritative display fields the card needs.

    A no-op for every tool without a registered enricher, and for any failure —
    the card still shows the raw arguments rather than blocking on a lookup.
    """
    enricher = _ENRICHERS.get(tool_name)
    if enricher is None or not isinstance(arguments, dict) or not user_id:
        return arguments
    try:
        return await enricher(arguments, user_id=user_id)
    except Exception as e:  # noqa: BLE001 — a preview lookup must never block the card
        logger.warning(
            "approval.preview_enrich_failed",
            tool=tool_name,
            error=str(e),
        )
        return arguments
