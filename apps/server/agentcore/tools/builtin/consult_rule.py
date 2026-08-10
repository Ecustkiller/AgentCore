"""consult_rule — pull an on_demand user rule's full text (渐进披露 · 定案 B).

Wired when the turn has at least one ``apply_mode=on_demand`` user rule (empty catalog ⇒
not wired AND the「规则目录」is not rendered — same live-tool gate as ``consult_memory``).
CEO + worker (AUDIENCE_BOTH), independent of the memory master switch: user rules are the
user's own instructions, not AI memory.

Implements the small :class:`~agentcore.runtime.context.consultable.Consultable` shape
(目录 + 按名取文). Soft miss on wrong name (``success=True``); missing ``name`` is a real
parameter failure. Always-injected rules are NOT reachable here — they already ride ``<rules>``.

Sidecar account-ticket turns load catalog + bodies via ``POST …/account/rules/list``
(same narrow surface as always rules); cloud/server turns read the document DB.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import DocumentRepository
from agentcore.memory.rules_injection import (
    lookup_on_demand_rule_body_from_cloud,
    on_demand_user_rules_from_cloud,
    rule_consult_name,
)
from agentcore.runtime.context.consultable import ConsultDirectoryEntry
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

logger = get_logger(__name__)

_CONSULT_OUTPUT_LIMIT = 8000


@dataclass
class ConsultRuleTool:
    """On-demand user-rule recall: name → rule body (Consultable shape).

    ``folder_id`` ⇒ project-then-global resolution (same scope merge as consult_memory).
    """

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_BOTH,
        ceo_wire=CeoWire.RULES,
    )

    folder_id: str | None = None

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="consult_rule",
            description=(
                "按 name 查阅一条「按需用户规则」的全文：你的系统提示词里有一张「规则目录」"
                "列出该用户可查阅的按需规则 name；当某条与当前任务相关时，用本工具把它的全文"
                "拉回来（作为工具结果返回），读完须遵守。常驻的 always 用户规则已在提示词"
                "``<rules>`` 里、无需查阅；只有目录中列出的按需规则才用本工具拉取。"
                "按需规则是约束/合规附录，不是记忆主题（记忆主题用 consult_memory）。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": (
                            "要查阅的按需用户规则名称，取自系统提示词「规则目录」里列出的 name"
                            "（如 合规附录）。"
                        ),
                    },
                },
                "required": ["name"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def list_directory(self, user_id: str) -> Sequence[ConsultDirectoryEntry]:
        """Consultable: catalog rows (names only here — summaries live in prompt render)."""
        names = await self._available_names(user_id)
        return [ConsultDirectoryEntry(name=n) for n in names]

    async def fetch_by_name(self, user_id: str, name: str) -> str | None:
        """Consultable: body or None on miss."""
        key = rule_consult_name(name)
        if not key:
            return None
        payload = await self._cloud_rules_payload()
        if payload is not None:
            return lookup_on_demand_rule_body_from_cloud(
                payload, folder_id=self.folder_id, name=key
            )
        async with async_session_factory() as session:
            repo = DocumentRepository(session)
            if self.folder_id:
                body = await self._load_named(repo, user_id, self.folder_id, key)
                if body is not None:
                    return body
            return await self._load_named(repo, user_id, None, key)

    async def _available_names(self, user_id: str) -> list[str]:
        payload = await self._cloud_rules_payload()
        if payload is not None:
            return [
                r.name
                for r in on_demand_user_rules_from_cloud(
                    payload, folder_id=self.folder_id
                )
            ]
        async with async_session_factory() as session:
            repo = DocumentRepository(session)
            names = {
                rule_consult_name(d.name)
                for d in await repo.list_on_demand_user_rules(user_id, None)
                if rule_consult_name(d.name)
            }
            if self.folder_id:
                names |= {
                    rule_consult_name(d.name)
                    for d in await repo.list_on_demand_user_rules(user_id, self.folder_id)
                    if rule_consult_name(d.name)
                }
            return sorted(names)

    async def _cloud_rules_payload(self) -> Mapping[str, object] | None:
        """Account-ticket list payload, or None when this turn is local-DB."""
        from agentcore.account.credentials import (
            cloud_list_user_rules,
            get_account_credentials,
        )

        creds = get_account_credentials()
        if creds is None:
            return None
        return await cloud_list_user_rules(creds, folder_id=self.folder_id)

    @staticmethod
    async def _load_named(
        repo: DocumentRepository, user_id: str, folder_id: str | None, key: str
    ) -> str | None:
        for doc in await repo.list_on_demand_user_rules(user_id, folder_id):
            if rule_consult_name(doc.name) == key:
                body = doc.content or ""
                return body if body.strip() else None
        return None

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        raw = str(arguments.get("name") or "").strip()
        key = rule_consult_name(raw)
        if not key:
            available = "、".join(await self._available_names(context.user_id))
            msg = "缺少 name 参数。"
            if available:
                msg += f" 可查阅的按需规则：{available}。"
            logger.info("consult_rule.miss", name=raw, folder_id=self.folder_id)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg)

        body = await self.fetch_by_name(context.user_id, key)
        if body is None:
            available = "、".join(await self._available_names(context.user_id))
            head = f"没有名为 '{raw}' 的按需用户规则。"
            tail = (
                f" 可查阅的按需规则：{available}。"
                if available
                else " 当前没有任何按需用户规则。"
            )
            logger.info("consult_rule.miss", name=raw, folder_id=self.folder_id)
            return ToolResult(tool_call_id="", success=True, output=head + tail)

        logger.info("consult_rule.hit", name=key, folder_id=self.folder_id)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=body,
            output_limit=_CONSULT_OUTPUT_LIMIT,
            display={"rule": key},
        )
