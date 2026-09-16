"""remember — write a named user-rule markdown under AgentCore/规则/.

One topic, one file. The user owns these documents (``role='rule', ai_maintained=false``).
Idle digest never rewrites them. Next turn's ``<设定>`` (always) or ``consult`` (on_demand)
picks them up.

Workspace ``file_write`` is a different pen — it does not inject as user rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agentcore.account.credentials import AccountCloudError
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import DocumentRepository
from agentcore.memory.always_quota import AlwaysQuotaExceededError
from agentcore.memory.rules_injection import UserRuleMutationResult, mutate_user_rule
from agentcore.tools.builtin.file_ops import has_omission_marker
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

logger = get_logger(__name__)

_TRAILING_ELLIPSIS_SUFFIXES = ("……", "...", "…")
_INCOMPLETE_CONTENT_MSG = (
    "拒绝写入：正文不完整。请写完整一篇，勿用省略号收口或中间省略标记。"
)


def _is_incomplete_rule_content(content: str) -> bool:
    """True when write content looks truncated (mid markers or trailing ellipsis)."""
    if not content:
        return False
    if has_omission_marker(content):
        return True
    return any(content.endswith(s) for s in _TRAILING_ELLIPSIS_SUFFIXES)


@dataclass
class RememberTool:
    """CEO-only: write / read / delete / list named user-rule markdown files."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.MEMORY,
        catalog_summary="把用户规矩写成一篇规则文件",
    )

    folder_id: str | None = None

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="remember",
            description=(
                "把用户要长期遵守的规矩写成 AgentCore/规则/ 下一篇 markdown"
                "（一个主题一篇）。给人看先写在对话里，确认后再 write。"
                "工作区 file_write ≠ 本工具。调研简报 / 画像 ≠ 本工具。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["write", "read", "delete", "list"],
                        "description": (
                            "write=整篇覆盖（默认）；read=读一篇；"
                            "delete=删一篇；list=列出文件名（不写盘）。"
                        ),
                    },
                    "name": {
                        "type": "string",
                        "description": (
                            "文件名，短标题，如「回复语言.md」。"
                            "write/read/delete 必填；list 不需要。"
                        ),
                    },
                    "content": {
                        "type": "string",
                        "description": "write 时的完整正文（markdown，可含章节）。",
                    },
                    "apply": {
                        "type": "string",
                        "enum": ["always", "on_demand"],
                        "description": (
                            "write 时：always=每场都带上（新建默认）；"
                            "on_demand=用到再查。"
                        ),
                    },
                    "description": {
                        "type": "string",
                        "description": "一行摘要，按需目录用；可空。",
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["global", "folder"],
                        "description": (
                            "global=对所有对话生效（默认）；folder=仅当前文件夹生效。"
                        ),
                    },
                },
                "required": [],
            },
            face=ToolFace.FOLDER,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        action = str(arguments.get("action") or "write").strip().lower() or "write"
        name_raw = arguments.get("name")
        name = str(name_raw).strip() if name_raw is not None else ""
        content_raw = arguments.get("content")
        content = str(content_raw).strip() if content_raw is not None else ""
        apply_raw = arguments.get("apply")
        apply = str(apply_raw).strip().lower() if apply_raw is not None else None
        if apply == "":
            apply = None
        if apply is not None and apply not in ("always", "on_demand"):
            return ToolResult(
                tool_call_id="",
                success=False,
                output="apply 只能是 always 或 on_demand。",
                error="apply 只能是 always 或 on_demand。",
            )
        desc_raw = arguments.get("description")
        description = str(desc_raw).strip() if desc_raw is not None else None
        if description == "":
            description = None
        scope_token = str(arguments.get("scope") or "global").strip().lower()
        folder_id = self.folder_id if scope_token == "folder" and self.folder_id else None

        if action == "write" and _is_incomplete_rule_content(content):
            return ToolResult(
                tool_call_id="",
                success=False,
                output=_INCOMPLETE_CONTENT_MSG,
                error=_INCOMPLETE_CONTENT_MSG,
            )
        if action in ("write", "read", "delete") and not name:
            msg = "缺少 name。一个主题一篇文件，例如 回复语言.md。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)
        if action == "write" and not content:
            msg = "缺少 content。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        creds = None
        try:
            from agentcore.account.credentials import (
                cloud_remember_rule,
                get_account_credentials,
            )

            creds = get_account_credentials()
            if creds is not None:
                payload = await cloud_remember_rule(
                    creds,
                    action=action,
                    name=name or None,
                    content=content or None,
                    folder_id=folder_id,
                    apply=apply,
                    description=description,
                )
                result = _result_from_cloud(
                    payload, action=action, name=name, apply=apply, content=content
                )
            else:
                async with async_session_factory() as session:
                    result = await mutate_user_rule(
                        DocumentRepository(session),
                        context.user_id,
                        folder_id=folder_id,
                        action=action,
                        name=name or None,
                        content=content or None,
                        apply=apply,
                        description=description,
                    )
        except AlwaysQuotaExceededError as e:
            return ToolResult(
                tool_call_id="",
                success=False,
                output=e.message,
                error=e.message,
            )
        except AccountCloudError as e:
            if e.code == "ALWAYS_QUOTA_EXCEEDED":
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output=e.message,
                    error=e.message,
                )
            logger.warning("memory.remember_failed", user_id=context.user_id, error=str(e))
            return ToolResult(
                tool_call_id="",
                success=False,
                output="记住失败，请稍后再试。",
                error=str(e),
            )
        except Exception as e:  # noqa: BLE001 - a tool failure must not crash the turn
            logger.warning("memory.remember_failed", user_id=context.user_id, error=str(e))
            return ToolResult(
                tool_call_id="",
                success=False,
                output="记住失败，请稍后再试。",
                error=str(e),
            )

        if not result.ok:
            return ToolResult(
                tool_call_id="",
                success=False,
                output=result.message,
                error=result.message,
            )

        if result.changed:
            logger.info(
                "memory.remember_written",
                user_id=context.user_id,
                scope="folder" if folder_id else "global",
                action=result.action,
                name=result.name or None,
            )
            if creds is not None:
                await _rewarm_account_rules_memory(
                    creds,
                    user_id=context.user_id,
                    folder_id=self.folder_id,
                )

        display: dict[str, Any] = {
            "remembered": result.changed and result.action == "write",
            "changed": result.changed,
            "action": result.action,
            "name": result.name or None,
            "apply": result.apply or None,
            "content": content or None,
            "kind": "user_rule",
        }
        if result.action == "list" and result.catalog:
            display["catalog"] = [
                {"name": n, "apply": a, "description": d} for n, a, d in result.catalog
            ]
        if result.action == "read" and result.body:
            display["body"] = result.body

        return ToolResult(
            tool_call_id="",
            success=True,
            output=result.message,
            display=display,
        )


def _result_from_cloud(
    payload: dict[str, Any],
    *,
    action: str,
    name: str,
    apply: str | None,
    content: str,
) -> UserRuleMutationResult:
    catalog_raw = payload.get("catalog") or []
    catalog: tuple[tuple[str, str, str], ...] = ()
    if isinstance(catalog_raw, list):
        catalog = tuple(
            (
                str(item.get("name") or ""),
                str(item.get("apply") or ""),
                str(item.get("description") or ""),
            )
            for item in catalog_raw
            if isinstance(item, dict)
        )
    result = UserRuleMutationResult(
        action=str(payload.get("action") or action),
        changed=bool(payload.get("changed")),
        message=str(payload.get("message") or ""),
        name=str(payload.get("name") or name),
        apply=str(payload.get("apply") or apply or ""),
        body=str(payload.get("body") or ""),
        catalog=catalog,
        content=content or None,
        ok=payload.get("ok") is not False,
    )
    if not result.message:
        result = UserRuleMutationResult(
            action=result.action,
            changed=result.changed,
            message=_fallback_cloud_message(result),
            name=result.name,
            apply=result.apply,
            body=result.body,
            catalog=result.catalog,
            content=result.content,
            ok=result.ok,
        )
    return result


def _fallback_cloud_message(result: UserRuleMutationResult) -> str:
    if result.action == "list":
        return result.message or "当前没有用户规则。"
    if result.changed:
        return f"已更新用户规则（action={result.action}）。"
    return "用户规则未变更。"


async def _rewarm_account_rules_memory(
    creds: Any,
    *,
    user_id: str,
    folder_id: str | None,
) -> None:
    """Best-effort re-seed of the ticketed prepare snapshot after a rule write."""
    try:
        from agentcore.memory.account_prepare_cache import warm_account_rules_memory

        await warm_account_rules_memory(creds, user_id=user_id, folder_id=folder_id)
    except Exception as e:  # noqa: BLE001 — remember already succeeded
        logger.warning(
            "memory.remember_rewarm_failed",
            user_id=user_id,
            folder_id=folder_id,
            error=str(e),
        )


def build_remember_tool(*, folder_id: str | None = None) -> RememberTool:
    return RememberTool(folder_id=folder_id)
