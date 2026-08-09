"""CEO-only project roster tools: list / resolve / create (cloud).

P0 桶 A（跨项目并行指挥 §4.5–4.7）：名册与 ``GET /folders`` 同形（``FolderSummary``
字段；无 OS 绝对路径）。唯一命中可静默供后续派工；0 / 多名 → 由模型走
``ask_user`` ``kind=choice``（选项须可区分 mode 等；禁止静默猜「最近」）。

P1 桶 C（§4.8–4.10）：``create_project`` 经账号 API 同形路径新建 **云** Folder
（``POST /folders`` mode=cloud）；**不**改 ``conversation.folder_id``、**不**新开会话。
与 ``open_local_project``（打开当出生=新会话）分流；
本地「登记留指挥面」走 ask ``register_local_project``。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from agentcore.api.schemas.conversations import FolderSummary
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.db.base import async_session_factory
from agentcore.db.errors import (
    DATABASE_UNAVAILABLE_CODE,
    DATABASE_UNAVAILABLE_MESSAGE,
    is_db_connectivity_error,
)
from agentcore.db.repositories import FolderRepository
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

logger = get_logger(__name__)

LIST_PROJECTS_TOOL_NAME = "list_projects"
RESOLVE_PROJECT_TOOL_NAME = "resolve_project"
CREATE_PROJECT_TOOL_NAME = "create_project"

_AMBIGUOUS_HINT = (
    "多名命中：请用 ask_user（kind=choice，multiple=false）让用户选一个；"
    "选项 label 须含 name 与 mode（及 local_subpath 等可区分信息）；"
    "禁止静默猜「最近」；禁止用 open_local_project 冒充选已有项目（那会新会话）。"
)
_NOT_FOUND_HINT = (
    "零命中：请向用户确认项目名，或用 list_projects 核对名册后再 ask_user；"
    "若需新建：云项目用 create_project（同指挥面登记，不改本会话归属、不新开会话）；"
    "本地项目请走 ask_user（action=register_local_project）登记留指挥面；"
    "勿用 open_local_project——那是打开当出生、会新会话；"
    "禁止静默猜「最近」。"
)
_EMPTY_LIST_HINT = (
    "当前账号下没有项目。需要新建时：云项目用 create_project（同指挥面）；"
    "本地登记留指挥面：ask_user action=register_local_project——"
    "勿默认催 open_local_project（那会新会话）。"
    "多项目同时开工须先有名册项再 resolve→同次 delegate(target_folder_id)；"
    "开发双仓≠external_mount_readonly。"
)
_RESOLVED_TIP = (
    "空/近空先 ask_user 钉目标，勿连续 file_list 确认空；"
    "多项目同次 delegate 各填 target_folder_id；"
    "裸聊同回合仅此唯一目标时可省略 target（运行时继承）；"
    "开发双仓≠external_mount_readonly。"
)


def folder_summary_dict(folder: Any) -> dict[str, Any]:
    """Same wire shape as ``GET /folders`` (``FolderSummary``)."""
    return FolderSummary.from_folder(folder).model_dump(mode="json")


@dataclass(frozen=True)
class ResolveOutcome:
    status: Literal["resolved", "ambiguous", "not_found"]
    matches: tuple[dict[str, Any], ...]


def resolve_projects_by_name(
    summaries: Sequence[dict[str, Any]],
    name: str,
) -> ResolveOutcome:
    """Match ``name`` against FolderSummary-shaped dicts (case-insensitive).

    Exact name match first; if none, substring (``name in folder.name``).
    Never ranks by recency — unique ⇒ resolved; 0 ⇒ not_found; many ⇒ ambiguous.
    """
    needle = name.strip()
    if not needle:
        return ResolveOutcome(status="not_found", matches=())

    lowered = needle.casefold()
    exact = tuple(s for s in summaries if str(s.get("name") or "").casefold() == lowered)
    if len(exact) == 1:
        return ResolveOutcome(status="resolved", matches=exact)
    if len(exact) > 1:
        return ResolveOutcome(status="ambiguous", matches=exact)

    partial = tuple(
        s for s in summaries if lowered in str(s.get("name") or "").casefold()
    )
    if len(partial) == 1:
        return ResolveOutcome(status="resolved", matches=partial)
    if len(partial) > 1:
        return ResolveOutcome(status="ambiguous", matches=partial)
    return ResolveOutcome(status="not_found", matches=())


async def _load_user_project_summaries(user_id: str) -> list[dict[str, Any]]:
    from agentcore.folders.credentials import (
        FoldersCloudError,
        cloud_list_folders,
        get_folders_credentials,
    )

    creds = get_folders_credentials()
    if creds is not None:
        try:
            return await cloud_list_folders(creds)
        except FoldersCloudError:
            raise
        except Exception as e:  # noqa: BLE001 — normalize unexpected HTTP failures
            raise FoldersCloudError(str(e)) from e

    async with async_session_factory() as session:
        folders = await FolderRepository(session).list_by_user(user_id)
    return [folder_summary_dict(f) for f in folders]


async def _create_cloud_folder(*, user_id: str, name: str) -> dict[str, Any]:
    """Account-level cloud Folder create — same semantics as ``POST /folders`` mode=cloud.

    Does **not** touch any Conversation row (no ``folder_id`` rebind, no new session).
    With folders narrow-ticket creds (sidecar), calls the cloud HTTP API instead of
    the local FolderRepository.
    """
    from agentcore.folders.credentials import (
        FoldersCloudError,
        cloud_create_cloud_folder,
        get_folders_credentials,
    )

    creds = get_folders_credentials()
    if creds is not None:
        try:
            return await cloud_create_cloud_folder(creds, name=name)
        except FoldersCloudError:
            raise
        except Exception as e:  # noqa: BLE001
            raise FoldersCloudError(str(e)) from e

    async with async_session_factory() as session:
        folder = await FolderRepository(session).create(
            user_id=user_id,
            name=name,
            local_root_id=None,
            local_subpath=None,
        )
    return folder_summary_dict(folder)


def _is_folders_cloud_failure(exc: BaseException) -> bool:
    from agentcore.folders.credentials import FoldersCloudError

    return isinstance(exc, FoldersCloudError)


def _json_output(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


class ListProjectsTool:
    """CEO-only: list the authenticated user's live projects (Folder 名册)."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.ALWAYS,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=LIST_PROJECTS_TOOL_NAME,
            description=(
                "列出当前用户账号下的全部【已有项目】（与侧栏 / GET /folders 同名册："
                "id、name、mode=local|cloud、local_root_id、local_subpath、时间戳；"
                "无本机绝对路径）。跨项目指挥前先查名册；按名定位请用 resolve_project；"
                "同指挥面新建云项目请用 create_project；"
                "多项目并行派工：resolve 后空/近空先 ask_user，确认后同次 "
                "delegate 各填 target_folder_id（开发双仓≠external_mount_readonly）。"
                "【禁止】用 open_local_project 代替本工具——那会新建会话，不是列已有。"
            ),
            parameters={"type": "object", "properties": {}, "required": []},
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        del arguments  # no params
        try:
            projects = await _load_user_project_summaries(context.user_id)
        except Exception as e:  # noqa: BLE001 — tool failure must not crash the turn
            cloud_fail = _is_folders_cloud_failure(e)
            logger.warning(
                "projects.list_failed",
                user_id=context.user_id,
                error=str(e),
                db_unreachable=is_db_connectivity_error(e),
                folders_cloud_failed=cloud_fail,
            )
            if is_db_connectivity_error(e):
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output=f"列出项目失败。{DATABASE_UNAVAILABLE_MESSAGE}",
                    error=DATABASE_UNAVAILABLE_CODE,
                )
            if cloud_fail:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output=f"列出项目失败。{e}",
                    error=getattr(e, "code", "folders_cloud_failed"),
                )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="列出项目失败，请稍后再试。",
                error=str(e),
            )

        logger.info(
            "projects.listed",
            user_id=context.user_id,
            count=len(projects),
            run_id=context.run_id,
        )
        payload = {"projects": projects, "count": len(projects)}
        if not projects:
            text = _EMPTY_LIST_HINT + "\n" + _json_output(payload)
        else:
            text = f"共 {len(projects)} 个项目：\n" + _json_output(payload)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=text,
            display={"count": len(projects)},
        )


class ResolveProjectTool:
    """CEO-only: resolve a spoken / typed project name to a Folder id."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.ALWAYS,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=RESOLVE_PROJECT_TOOL_NAME,
            description=(
                "按项目名解析为已有 Folder（与 GET /folders 同形字段）。"
                "唯一命中 → 返回该项目（可静默供后续派工使用；空/近空先 ask_user，"
                "勿连续 file_list 确认空；多项目同次 delegate 各填 target_folder_id；"
                "开发双仓≠external_mount_readonly）；"
                "零命中或多名 → 返回候选并提示用 ask_user kind=choice 让用户选"
                "（选项须可区分 name/mode 等；禁止静默猜「最近」）。"
                "零命中若需新建：云 → create_project；本地 → ask_user "
                "register_local_project（勿用 open_local_project 冒充先建后干——"
                "那会新会话）。"
                "【禁止】用 open_local_project 代替本工具选已有项目（那会新会话）。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "用户口述或写出的项目名（精确或可唯一子串）。",
                    },
                },
                "required": ["name"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        name = str(arguments.get("name") or "").strip()
        if not name:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="缺少 name（要解析的项目名）。",
                error="missing name",
            )

        try:
            projects = await _load_user_project_summaries(context.user_id)
        except Exception as e:  # noqa: BLE001
            cloud_fail = _is_folders_cloud_failure(e)
            logger.warning(
                "projects.resolve_failed",
                user_id=context.user_id,
                error=str(e),
                db_unreachable=is_db_connectivity_error(e),
                folders_cloud_failed=cloud_fail,
            )
            if is_db_connectivity_error(e):
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output=f"解析项目失败。{DATABASE_UNAVAILABLE_MESSAGE}",
                    error=DATABASE_UNAVAILABLE_CODE,
                )
            if cloud_fail:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output=f"解析项目失败。{e}",
                    error=getattr(e, "code", "folders_cloud_failed"),
                )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="解析项目失败，请稍后再试。",
                error=str(e),
            )

        outcome = resolve_projects_by_name(projects, name)
        logger.info(
            "projects.resolved",
            user_id=context.user_id,
            status=outcome.status,
            match_count=len(outcome.matches),
            run_id=context.run_id,
        )

        if outcome.status == "resolved":
            project = outcome.matches[0]
            context.turn_target_desk.note_folder(
                project.get("id") if isinstance(project.get("id"), str) else None
            )
            payload: dict[str, Any] = {
                "status": "resolved",
                "query": name,
                "project": project,
            }
            return ToolResult(
                tool_call_id="",
                success=True,
                output=(
                    "唯一命中，可直接用于后续派工"
                    f"（{_RESOLVED_TIP}）：\n" + _json_output(payload)
                ),
                display={
                    "status": "resolved",
                    "folder_id": project.get("id"),
                    "name": project.get("name"),
                    "mode": project.get("mode"),
                },
            )

        if outcome.status == "ambiguous":
            payload = {
                "status": "ambiguous",
                "query": name,
                "matches": list(outcome.matches),
                "hint": _AMBIGUOUS_HINT,
            }
            return ToolResult(
                tool_call_id="",
                success=True,
                output=_AMBIGUOUS_HINT + "\n" + _json_output(payload),
                display={
                    "status": "ambiguous",
                    "match_count": len(outcome.matches),
                },
            )

        payload = {
            "status": "not_found",
            "query": name,
            "matches": [],
            "hint": _NOT_FOUND_HINT,
        }
        return ToolResult(
            tool_call_id="",
            success=True,
            output=_NOT_FOUND_HINT + "\n" + _json_output(payload),
            display={"status": "not_found", "match_count": 0},
        )


class CreateProjectTool:
    """CEO-only: create a cloud project on the account (同指挥面先建后干).

    Mirrors ``POST /v1/folders`` with ``mode=cloud``. Returns FolderSummary-shaped
    payload for subsequent ``resolve_project`` / ``delegate(target_folder_id=…)``.
    Never mutates the current conversation's ``folder_id`` or starts a new session.
    Local register-stay-command-surface is bucket D — not this tool.
    """

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.ALWAYS,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=CREATE_PROJECT_TOOL_NAME,
            description=(
                "在当前用户账号下新建一个【云项目】（空工作区 Folder；等同 "
                "POST /folders mode=cloud）。同指挥面先建后干：建完返回 FolderSummary "
                "同形字段（id/name/mode=cloud/…），可供随后 resolve_project 或 "
                "delegate(target_folder_id=…) 使用。"
                "【不变式】不改本会话 conversation.folder_id / 出生 / 默认桌；不新开会话；"
                "≠ 写盘改代码（CEO 仍无 file mutation）。"
                "【禁止】用 open_local_project 冒充本能力——那是「打开当出生」、会新会话。"
                "本地登记留指挥面走 ask register_local_project；本工具只建云。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "新云项目显示名（账号侧允许重名）。",
                    },
                },
                "required": ["name"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        name = str(arguments.get("name") or "").strip()
        if not name:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="缺少 name（新云项目名称）。",
                error="missing name",
            )

        # Account API only — never rebind conversation.folder_id (context.conversation_id
        # is intentionally unused beyond logging).
        try:
            project = await _create_cloud_folder(user_id=context.user_id, name=name)
        except Exception as e:  # noqa: BLE001
            cloud_fail = _is_folders_cloud_failure(e)
            logger.warning(
                "projects.create_failed",
                user_id=context.user_id,
                conversation_id=context.conversation_id or None,
                error=str(e),
                folders_cloud_failed=cloud_fail,
            )
            if cloud_fail:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output=f"创建云项目失败。{e}",
                    error=getattr(e, "code", "folders_cloud_failed"),
                )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="创建云项目失败，请稍后再试。",
                error=str(e),
            )

        folder_id = project.get("id") if isinstance(project.get("id"), str) else None
        context.turn_target_desk.note_folder(folder_id)
        logger.info(
            "projects.created",
            user_id=context.user_id,
            folder_id=folder_id,
            conversation_id=context.conversation_id or None,
            conversation_untouched=True,
            run_id=context.run_id,
        )
        payload = {
            "status": "created",
            "project": project,
            "conversation_untouched": True,
            "hint": (
                "云项目已登记在账号名册；本会话归属/默认桌未改。"
                "可直接用返回的 id 作为 delegate target_folder_id；"
                "裸聊同回合仅此一个目标时也可省略（运行时继承）。"
                "多项目同回合仍须各 task 显式点名。"
            ),
        }
        return ToolResult(
            tool_call_id="",
            success=True,
            output=(
                "已创建云项目（同指挥面；未改会话归属、未新开会话）：\n"
                + _json_output(payload)
            ),
            display={
                "status": "created",
                "folder_id": project.get("id"),
                "name": project.get("name"),
                "mode": project.get("mode"),
                "conversation_untouched": True,
            },
        )
