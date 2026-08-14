"""Filesystem meta tools: delete / move / copy / mkdir."""

from __future__ import annotations

import time
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.file_products import file_product
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_WORKER_ONLY,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)
from agentcore.workspace.protocol import (
    AlreadyExists,
    OutsideWorkspace,
    PathNotFound,
    WorkspaceError,
)

from .errors import (
    _error,
    _maybe_channel_dead_error,
    _outside_workspace_msg,
    _path_missing_error,
)
from .integrity import (
    _claim_write_path,
    _prepare_write_relpath,
    _reject_write_scope,
    is_substantial_existing_body,
    substantial_delete_rejection,
)

logger = get_logger(__name__)

class FileDeleteTool:
    """Delete a file, or a directory and all its contents, within the workspace."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_WORKER_ONLY,
        # 删除只会让台账里的 path 消失，不产生新产物。
        file_products=FileProductsContract.NO_PRODUCT,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_delete",
            description=(
                "删除一个文件，或一个目录【及其全部内容】（递归）。默认【可逆】："
                "本地模式移入系统回收站（请在本机系统回收站手动恢复，产品不提供"
                "一键还原）；云端 / sidecar / 无系统回收站时移入工作区软删除区"
                "AgentCore/trash（可通过工作区「回收站」一键还原，保留期与"
                "工作区软删一致）。仅当 permanent=true 时才永久删除。工作区根"
                "目录本身不可删除。路径必须是相对于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "要删除的文件或目录的相对路径",
                    },
                    "permanent": {
                        "type": "boolean",
                        "description": (
                            "true = 永久删除（不可恢复）；默认 false = 可逆删除"
                            "（本地→系统回收站；云端/sidecar→AgentCore/trash）。"
                        ),
                        "default": False,
                    },
                },
                "required": ["path"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        permanent = bool(arguments.get("permanent", False))

        if not rel_path:
            return _error("path 不能为空：请提供工作区内的相对文件路径", start)

        from agentcore.workspace.project_shell import rewrite_project_shell_relpath

        rel_path, _shell_note = await rewrite_project_shell_relpath(
            rel_path, context, register=False
        )
        if not rel_path:
            return _error("path 不能为空：请提供工作区内的相对文件路径", start)

        scope_denied = _reject_write_scope(
            context, rel_path, start, event="file_write.scope_rejected"
        )
        if scope_denied is not None:
            return scope_denied

        denied, release_on_fail = _claim_write_path(
            context, rel_path, event="file_delete.collision", start=start
        )
        if denied is not None:
            return denied
        coordinator = context.write_coordinator

        # 成篇质量：禁止「删长文 → 整篇重写」烧预算（delete 闸）；
        # file_write 整盖已允许，仅软 integrity nudge。
        old_content: str | None = None
        try:
            old_content = await context.backend.read(rel_path)
        except PathNotFound:
            old_content = None
        except WorkspaceError:
            # Directory / binary / outside — let delete path surface the real error.
            old_content = None
        if old_content is not None and is_substantial_existing_body(old_content):
            old_chars = len(old_content.strip())
            logger.info(
                "file_delete.substantial_rejected",
                path=rel_path,
                old_chars=old_chars,
            )
            if coordinator is not None and release_on_fail:
                coordinator.release(rel_path, context.run_id)
            return _error(
                substantial_delete_rejection(rel_path, old_chars),
                start,
                contract_failure=True,
            )

        try:
            await context.backend.delete(rel_path, permanent=permanent)
        except OutsideWorkspace:
            if coordinator is not None and release_on_fail:
                coordinator.release(rel_path, context.run_id)
            return _error(
                _outside_workspace_msg(rel_path, location=context.backend.location),
                start,
            )
        except PathNotFound:
            if coordinator is not None and release_on_fail:
                coordinator.release(rel_path, context.run_id)
            return _path_missing_error(f"路径不存在：{rel_path}", start)
        except WorkspaceError as e:
            if coordinator is not None and release_on_fail:
                coordinator.release(rel_path, context.run_id)
            dead = _maybe_channel_dead_error(e, start)
            if dead is not None:
                return dead
            return _error(f"删除失败：{e}", start, user_face=False)

        if permanent:
            msg = f"已永久删除 {rel_path}"
        else:
            msg = (
                f"已可逆删除 {rel_path}"
                "（本地通道→系统回收站，请在本机手动恢复；"
                "云端/sidecar→AgentCore/trash，可工作区一键还原）"
            )

        return ToolResult(
            tool_call_id="",
            success=True,
            output=msg,
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileMoveTool:
    """Move or rename a file or directory within the workspace."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_WORKER_ONLY,
        file_products=FileProductsContract.SELF_REPORT,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_move",
            description=(
                "在工作区内移动或重命名文件 / 目录。可用于重命名（在同一目录内"
                "移动）或把路径迁到新位置；目标路径缺失的上级目录会自动创建。若"
                "目标已存在则失败——【不会覆盖】。约定文档前缀下目标路径可能被扁平化；"
                "与源规范化后相同则视为已到位（幂等成功）。两个路径都必须是相对"
                "于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "要移动的已有文件 / 目录的相对路径",
                    },
                    "destination": {
                        "type": "string",
                        "description": "目标相对路径（必须尚不存在）",
                    },
                },
                "required": ["source", "destination"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        source = arguments.get("source", "")
        requested_dest = arguments.get("destination", "")

        if not source or not requested_dest:
            return _error("'source' 与 'destination' 均为必填", start)

        from agentcore.workspace.project_shell import rewrite_project_shell_relpath

        # Dest first: empty-desk first shot may register; source then shares that slug.
        destination, rename_note = await _prepare_write_relpath(requested_dest, context)
        source, _src_note = await rewrite_project_shell_relpath(
            source, context, register=False
        )

        if source == destination:
            # Idempotent: already at the (sanitized) target — e.g. dossier flatten.
            output = "source 与 destination 相同，无需移动"
            if rename_note:
                output = f"{output}。{rename_note}"
            return ToolResult(
                tool_call_id="",
                success=True,
                output=output,
                duration_ms=int((time.monotonic() - start) * 1000),
                file_products=[file_product(destination)],
            )

        for p in (source, destination):
            scope_denied = _reject_write_scope(
                context, p, start, event="file_write.scope_rejected"
            )
            if scope_denied is not None:
                return scope_denied

        # Ownership: source must be ours (or free); destination must not be held by another.
        denied_src, release_src = _claim_write_path(
            context, source, event="file_move.collision", start=start
        )
        if denied_src is not None:
            return denied_src
        denied_dst, release_dst = _claim_write_path(
            context, destination, event="file_move.collision", start=start
        )
        if denied_dst is not None:
            coordinator = context.write_coordinator
            if coordinator is not None and release_src:
                coordinator.release(source, context.run_id)
            return denied_dst
        coordinator = context.write_coordinator

        try:
            await context.backend.move(source, destination)
        except OutsideWorkspace as e:
            if coordinator is not None:
                if release_src:
                    coordinator.release(source, context.run_id)
                if release_dst:
                    coordinator.release(destination, context.run_id)
            return _error(_outside_workspace_msg(str(e), location=context.backend.location), start)
        except PathNotFound:
            if coordinator is not None:
                if release_src:
                    coordinator.release(source, context.run_id)
                if release_dst:
                    coordinator.release(destination, context.run_id)
            return _path_missing_error(f"源路径不存在：{source}", start)
        except AlreadyExists:
            if coordinator is not None:
                if release_src:
                    coordinator.release(source, context.run_id)
                if release_dst:
                    coordinator.release(destination, context.run_id)
            return _error(
                f"目标已存在：{destination}。请换一个不存在的路径，或先删除它。",
                start,
            )
        except WorkspaceError as e:
            if coordinator is not None:
                if release_src:
                    coordinator.release(source, context.run_id)
                if release_dst:
                    coordinator.release(destination, context.run_id)
            dead = _maybe_channel_dead_error(e, start)
            if dead is not None:
                return dead
            return _error(f"移动失败：{e}", start, user_face=False)

        # Successful move: drop source ownership key; destination already claimed.
        if coordinator is not None:
            coordinator.release(source, context.run_id)

        output = f"已把 {source} 移动到 {destination}"
        if rename_note:
            output = f"{output}。{rename_note}"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            # 搬家不是派生（源不是中间稿），只报落地路径，不填 derived_from。
            file_products=[file_product(destination)],
        )


class FileCopyTool:
    """Copy a file or directory tree within the workspace (binary-safe)."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_WORKER_ONLY,
        file_products=FileProductsContract.SELF_REPORT,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_copy",
            description=(
                "在工作区内复制文件或【目录树】（含二进制）。目标路径缺失的上级"
                "目录会自动创建；若目标已存在则失败——【不会覆盖】。不能复制到"
                "自身或其子目录。约定文档前缀下目标路径可能被扁平化；与源规范化后"
                "相同则视为已到位（幂等成功）。两个路径都必须是相对于工作区的"
                "相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "要复制的已有文件 / 目录的相对路径",
                    },
                    "destination": {
                        "type": "string",
                        "description": "目标相对路径（必须尚不存在）",
                    },
                },
                "required": ["source", "destination"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        source = arguments.get("source", "")
        requested_dest = arguments.get("destination", "")

        if not source or not requested_dest:
            return _error("'source' 与 'destination' 均为必填", start)

        from agentcore.workspace.project_shell import rewrite_project_shell_relpath

        # Dest first: empty-desk first shot may register; source then shares that slug.
        destination, rename_note = await _prepare_write_relpath(requested_dest, context)
        source, _src_note = await rewrite_project_shell_relpath(
            source, context, register=False
        )

        if source == destination:
            # Idempotent: already at the (sanitized) target — e.g. dossier flatten.
            output = "source 与 destination 相同，无需复制"
            if rename_note:
                output = f"{output}。{rename_note}"
            return ToolResult(
                tool_call_id="",
                success=True,
                output=output,
                duration_ms=int((time.monotonic() - start) * 1000),
                file_products=[file_product(destination)],
            )

        scope_denied = _reject_write_scope(
            context, destination, start, event="file_write.scope_rejected"
        )
        if scope_denied is not None:
            return scope_denied

        try:
            await context.backend.copy(source, destination)
        except OutsideWorkspace as e:
            return _error(_outside_workspace_msg(str(e), location=context.backend.location), start)
        except PathNotFound:
            return _path_missing_error(f"源路径不存在：{source}", start)
        except AlreadyExists:
            return _error(
                f"目标已存在：{destination}。请换一个不存在的路径，或先删除它。",
                start,
            )
        except WorkspaceError as e:
            dead = _maybe_channel_dead_error(e, start)
            if dead is not None:
                return dead
            return _error(f"复制失败：{e}", start, user_face=False)

        output = f"已把 {source} 复制到 {destination}"
        if rename_note:
            output = f"{output}。{rename_note}"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            file_products=[file_product(destination)],
        )


class MkdirTool:
    """Create an empty directory (with parents) within the workspace."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_WORKER_ONLY,
        # 只建目录：台账记的是文件产物，空目录不是交付物。
        file_products=FileProductsContract.NO_PRODUCT,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="mkdir",
            description=(
                "在工作区内创建空目录（上级目录不存在时一并创建）。若路径已存在"
                "则失败。路径必须是相对于工作区的相对路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "要创建的相对目录路径",
                    },
                },
                "required": ["path"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")

        if not rel_path:
            return _error("path 不能为空：请提供工作区内的相对目录路径", start)

        rel_path, rename_note = await _prepare_write_relpath(
            rel_path, context, register_bare=True
        )
        if not rel_path or rel_path == ".":
            output = "工作区根已存在，无需创建目录"
            if rename_note:
                output = f"{output}。{rename_note}"
            return ToolResult(
                tool_call_id="",
                success=True,
                output=output,
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        scope_denied = _reject_write_scope(
            context, rel_path, start, event="file_write.scope_rejected"
        )
        if scope_denied is not None:
            return scope_denied

        try:
            await context.backend.mkdir(rel_path)
        except OutsideWorkspace:
            return _error(
                _outside_workspace_msg(rel_path, location=context.backend.location),
                start,
            )
        except AlreadyExists:
            return _error(f"路径已存在：{rel_path}", start)
        except WorkspaceError as e:
            dead = _maybe_channel_dead_error(e, start)
            if dead is not None:
                return dead
            return _error(f"创建目录失败：{e}", start, user_face=False)

        output = f"已创建目录 {rel_path}"
        if rename_note:
            output = f"{output}。{rename_note}"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
