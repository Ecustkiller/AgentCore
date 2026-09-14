"""Desk resolution for creation-doc tools (cloud folder only; not memory documents)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.db.models import Doc
from agentcore.doc.body import MAX_MARKDOWN_CHARS
from agentcore.folders.desk import DeskAccess, resolve_desk_access
from agentcore.tools.protocol import ToolContext, ToolResult

NO_DESK = "创作文档只挂云文件夹。把本对话挂到云文件夹，或传入 folder_id。"
NO_FOLDER = "文件夹不存在"
LOCAL_DESK = "文档只能建在云文件夹上。"
NOT_FOUND = "文档不存在"
NO_WRITE = "只读成员不能改文档。"
NO_USER = "无法确定用户。"
TOO_LONG = f"正文超过 {MAX_MARKDOWN_CHARS} 字，请缩短后再写。"
DEFAULT_TITLE = "未命名文档"


def fail(message: str) -> ToolResult:
    return ToolResult(tool_call_id="", success=False, output="", error=message)


def ok(
    output: str,
    *,
    display: dict[str, Any] | None = None,
    output_limit: int | None = None,
) -> ToolResult:
    return ToolResult(
        tool_call_id="",
        success=True,
        output=output,
        display=display,
        output_limit=output_limit,
    )


def actor_user_id(context: ToolContext) -> str:
    return (context.user_id or "").strip()


def resolve_folder_id(arguments: dict[str, Any], context: ToolContext) -> str | None:
    raw = arguments.get("folder_id")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    for candidate in (context.ownership_desk_id, context.auto_desk_folder_id):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def is_cloud_folder(folder: object) -> bool:
    return getattr(folder, "local_root_id", None) is None


async def require_cloud_desk(
    session: AsyncSession,
    *,
    folder_id: str,
    user_id: str,
    write: bool,
) -> DeskAccess | ToolResult:
    access = await resolve_desk_access(session, folder_id=folder_id, user_id=user_id)
    if access is None:
        return fail(NO_FOLDER)
    if not is_cloud_folder(access.folder):
        return fail(LOCAL_DESK)
    if write and not access.can_write:
        return fail(NO_WRITE)
    return access


async def load_visible_doc(
    session: AsyncSession,
    *,
    doc_id: str,
    user_id: str,
    write: bool,
) -> tuple[Doc, DeskAccess] | ToolResult:
    from agentcore.db.repositories.docs import DocRepository

    doc = await DocRepository(session).get_live(doc_id)
    if doc is None:
        return fail(NOT_FOUND)
    access = await resolve_desk_access(
        session, folder_id=doc.folder_id, user_id=user_id
    )
    if access is None or not is_cloud_folder(access.folder):
        return fail(NOT_FOUND)
    if write and not access.can_write:
        return fail(NO_WRITE)
    return doc, access


def iso(value: object) -> str | None:
    if value is None:
        return None
    stamp = getattr(value, "isoformat", None)
    if callable(stamp):
        return str(stamp())
    return str(value)


def summary_row(doc: Doc, folder_name: str, *, can_write: bool) -> dict[str, Any]:
    return {
        "id": doc.id,
        "title": doc.title,
        "folder_id": doc.folder_id,
        "folder_name": folder_name,
        "version": doc.version,
        "can_write": can_write,
        "updated_at": iso(doc.updated_at),
    }
