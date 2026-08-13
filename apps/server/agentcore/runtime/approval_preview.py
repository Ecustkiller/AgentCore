"""审批卡实名化：弹卡前把只有 id 的参数补成人能审的样子。

审批卡显示的就是模型发出的 arguments。``delete_folder`` 按 ``folder_id`` 删（跨层同名
合法，按名删必然误删），于是卡上只剩一串 UUID——用户根本审不了「删的是哪个文件夹」。

名字必须由**服务端权威名册**算出来，不能让模型多传一个 ``name`` 参数自报：模型报的
名字和 id 可能对不上，卡上就会写着「删 A」而实际删 B。这里加的键只进卡片预览与审计，
工具执行的仍是原始 arguments（见 ``engine.tool_exec_gates``）。

补的是**完整路径**而非末段名：嵌套之后「图标」可能在两处，只写末段等于没实名化。

失败即放弃（fail-soft）：查不到名字就照原样弹卡——查名失败时工具自己那次查也会失败并
拒绝执行，宁可卡上少一行，也不要为了好看而挡住审批链。
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

# Preview-only keys injected below. Clients strip / render them as card chrome,
# never as tool arguments.
FOLDER_NAME_PREVIEW_KEY = "folder_name"


async def _delete_folder_preview(
    arguments: dict[str, Any], *, user_id: str
) -> dict[str, Any]:
    from agentcore.tools.builtin.folders import folder_display_path, load_folder_summary

    folder_id = str(arguments.get("folder_id") or "").strip()
    if not folder_id or arguments.get(FOLDER_NAME_PREVIEW_KEY):
        return arguments
    folder = await load_folder_summary(user_id=user_id, folder_id=folder_id)
    if folder is None:
        return arguments
    label = folder_display_path(folder).strip()
    if not label:
        return arguments
    return {**arguments, FOLDER_NAME_PREVIEW_KEY: label}


_ENRICHERS = {"delete_folder": _delete_folder_preview}


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
