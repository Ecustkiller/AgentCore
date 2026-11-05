"""Atomic structured multi-file patches over exact text replacements."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.tools.cleared_write_stub import cleared_write_stub_rejection
from agentcore.tools.file_products import file_product
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)
from agentcore.workspace.protocol import (
    NotAFile,
    NotUTF8,
    PathNotFound,
    WorkspaceError,
)
from agentcore.workspace.text_replace import (
    TextReplaceAmbiguous,
    TextReplaceNoMatch,
    TextReplaceOk,
    apply_text_replace,
)

from .errors import (
    _error,
    _maybe_channel_dead_error,
    _write_io_error,
)
from .integrity import (
    _mark_landed_files,
    _reject_write_scope,
    prepared_write_relpath,
    stale_overwrite_rejection,
)
from .user_rules import classify_rule_path

logger = get_logger(__name__)

_PATCH_MAX_EDITS = 50


@dataclass
class _FilePatch:
    path: str
    original: str
    updated: str
    replacements: int = 0
    lines: list[int | None] = field(default_factory=list)
    rename_note: str = ""


class ApplyPatchTool:
    """Validate every edit first, then write files with best-effort rollback."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.SELF_REPORT,
        workspace_io=True,
        catalog_summary="一次原子修改多个文件",
        blurb="多文件精确修改，失败不留下半套",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="apply_patch",
            description=(
                "结构化多文件补丁：先校验全部替换，再写盘；中途失败会回滚已完成文件。"
                "每项使用精确 old_string，不处理用户规则目录。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": _PATCH_MAX_EDITS,
                        "description": "按顺序应用；同一文件可出现多次。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file_path": {
                                    "type": "string",
                                    "description": "工作区相对文件路径。",
                                },
                                "old_string": {
                                    "type": "string",
                                    "minLength": 1,
                                    "description": "磁盘上的精确原文。",
                                },
                                "new_string": {
                                    "type": "string",
                                    "description": "替换后的文本。",
                                },
                                "replace_all": {
                                    "type": "boolean",
                                    "default": False,
                                },
                            },
                            "required": ["file_path", "old_string", "new_string"],
                        },
                    },
                    "dry_run": {
                        "type": "boolean",
                        "description": "只预校验并报告，不写盘。",
                        "default": False,
                    },
                },
                "required": ["edits"],
            },
            face=ToolFace.FILE,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        stub_err = cleared_write_stub_rejection(arguments)
        if stub_err is not None:
            return _error(stub_err, start, contract_failure=True)

        raw = arguments.get("edits")
        if not isinstance(raw, list) or not raw:
            return _error("edits 必须是非空数组", start, contract_failure=True)
        if len(raw) > _PATCH_MAX_EDITS:
            return _error(
                f"edits 最多 {_PATCH_MAX_EDITS} 项",
                start,
                contract_failure=True,
            )

        plans: dict[str, _FilePatch] = {}
        for index, item in enumerate(raw, start=1):
            if not isinstance(item, dict):
                return _error(f"edits[{index}] 必须是对象", start, contract_failure=True)
            requested = str(item.get("file_path") or "").strip()
            old = item.get("old_string")
            new = item.get("new_string")
            replace_all = bool(item.get("replace_all", False))
            if not requested:
                return _error(
                    f"edits[{index}].file_path 不能为空",
                    start,
                    contract_failure=True,
                )
            if not isinstance(old, str) or not old:
                return _error(
                    f"edits[{index}].old_string 不能为空",
                    start,
                    contract_failure=True,
                )
            if not isinstance(new, str):
                return _error(
                    f"edits[{index}].new_string 必须是字符串",
                    start,
                    contract_failure=True,
                )
            if old == new:
                return _error(
                    f"edits[{index}] 的 old_string 与 new_string 相同",
                    start,
                    contract_failure=True,
                )
            if classify_rule_path(requested)[0] is not None:
                return _error(
                    "apply_patch 不处理 .agentcore 用户规则；请用 write/edit 的规则入口。",
                    start,
                    contract_failure=True,
                )

            prepared = await prepared_write_relpath(
                requested,
                context,
                host_grant_mode="attach_rw",
            )
            if isinstance(prepared, ToolResult):
                return prepared
            rel_path, rename_note = prepared
            if classify_rule_path(rel_path)[0] is not None:
                return _error(
                    "apply_patch 不处理 .agentcore 用户规则；请用 write/edit 的规则入口。",
                    start,
                    contract_failure=True,
                )
            denied = _reject_write_scope(
                context,
                rel_path,
                start,
                event="write.scope_rejected",
            )
            if denied is not None:
                return denied

            plan = plans.get(rel_path)
            if plan is None:
                try:
                    original = await context.backend.read(rel_path)
                except PathNotFound:
                    return _error(f"文件不存在：{rel_path}", start, contract_failure=True)
                except NotAFile:
                    return _error(f"不是文件：{rel_path}", start, contract_failure=True)
                except NotUTF8:
                    return _error(
                        f"无法编辑二进制 / 非 UTF-8 文件：{rel_path}",
                        start,
                        contract_failure=True,
                    )
                except WorkspaceError as exc:
                    dead = _maybe_channel_dead_error(exc, start)
                    if dead is not None:
                        return dead
                    return _write_io_error(exc, start)
                plan = _FilePatch(
                    path=rel_path,
                    original=original,
                    updated=original,
                    rename_note=rename_note,
                )
                plans[rel_path] = plan

            outcome = apply_text_replace(
                plan.updated,
                old,
                new,
                all_=replace_all,
            )
            if isinstance(outcome, TextReplaceNoMatch):
                return _error(
                    f"{rel_path}: edits[{index}] 的 old_string 未匹配当前内容；"
                    "未写入任何文件。",
                    start,
                    contract_failure=True,
                )
            if isinstance(outcome, TextReplaceAmbiguous):
                return _error(
                    f"{rel_path}: edits[{index}] 命中 {outcome.count} 处，"
                    "请扩大 old_string 或设 replace_all=true；未写入任何文件。",
                    start,
                    contract_failure=True,
                )
            assert isinstance(outcome, TextReplaceOk)
            plan.updated = outcome.content
            plan.replacements += outcome.count
            plan.lines.append(outcome.first_line)

        for plan in plans.values():
            try:
                current = await context.backend.read(plan.path)
            except WorkspaceError as exc:
                dead = _maybe_channel_dead_error(exc, start)
                if dead is not None:
                    return dead
                return _write_io_error(exc, start)
            if current != plan.original:
                return _error(
                    stale_overwrite_rejection(plan.path) + " 未写入任何文件。",
                    start,
                    contract_failure=True,
                )

        dry_run = bool(arguments.get("dry_run", False))
        if dry_run:
            return self._success(
                plans,
                start,
                dry_run=True,
            )

        written: list[_FilePatch] = []
        for plan in plans.values():
            try:
                current = await context.backend.read(plan.path)
            except (WorkspaceError, OSError) as exc:
                rollback = await self._rollback(context, written)
                dead = (
                    _maybe_channel_dead_error(exc, start)
                    if isinstance(exc, WorkspaceError)
                    else None
                )
                if dead is not None:
                    dead.error = f"{dead.error}；{rollback}"
                    return dead
                result = _write_io_error(exc, start)
                result.error = f"{result.error}；{rollback}"
                return result
            if current != plan.original:
                rollback = await self._rollback(context, written)
                return _error(
                    f"{stale_overwrite_rejection(plan.path)} {rollback}",
                    start,
                    contract_failure=True,
                )
            try:
                await context.backend.write(plan.path, plan.updated)
            except (WorkspaceError, OSError) as exc:
                dead = (
                    _maybe_channel_dead_error(exc, start)
                    if isinstance(exc, WorkspaceError)
                    else None
                )
                rollback = await self._rollback(context, written)
                if dead is not None:
                    dead.error = f"{dead.error}；{rollback}"
                    return dead
                result = _write_io_error(exc, start)
                result.error = f"{result.error}；{rollback}"
                return result
            written.append(plan)

        for plan in plans.values():
            _mark_landed_files(context, plan.path)
        context.invalidate_tool_cache()
        logger.info(
            "write.patch_applied",
            files=len(plans),
            replacements=sum(p.replacements for p in plans.values()),
        )
        return self._success(plans, start, dry_run=False)

    async def _rollback(
        self,
        context: ToolContext,
        written: list[_FilePatch],
    ) -> str:
        restored = 0
        conflicts: list[str] = []
        for plan in reversed(written):
            try:
                current = await context.backend.read(plan.path)
                if current != plan.updated:
                    conflicts.append(plan.path)
                    continue
                await context.backend.write(plan.path, plan.original)
                restored += 1
            except Exception:  # noqa: BLE001 - rollback is best effort
                conflicts.append(plan.path)
        if conflicts:
            return (
                f"已回滚 {restored}/{len(written)} 个文件；"
                f"以下文件回滚冲突：{', '.join(conflicts)}"
            )
        return f"已回滚 {restored}/{len(written)} 个已完成文件"

    def _success(
        self,
        plans: dict[str, _FilePatch],
        start: float,
        *,
        dry_run: bool,
    ) -> ToolResult:
        total = sum(plan.replacements for plan in plans.values())
        verb = "预校验通过，将修改" if dry_run else "已应用"
        lines = [f"{verb} {total} 处修改，涉及 {len(plans)} 个文件："]
        for plan in plans.values():
            where = "、".join(
                "全部" if line is None else f"约第 {line} 行"
                for line in plan.lines
            )
            lines.append(f"- {plan.path}: {plan.replacements} 处（{where}）")
            if plan.rename_note:
                lines.append(f"  {plan.rename_note}")
        return ToolResult(
            tool_call_id="",
            success=True,
            output="\n".join(lines),
            duration_ms=int((time.monotonic() - start) * 1000),
            metadata={
                "files": len(plans),
                "replacements": total,
                "dry_run": dry_run,
            },
            file_products=[] if dry_run else [
                file_product(plan.path) for plan in plans.values()
            ],
        )
