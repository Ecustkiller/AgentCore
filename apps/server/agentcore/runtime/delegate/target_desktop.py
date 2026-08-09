"""Target-desktop wiring for shape-甲 cross-project delegate (P0 桶 B · C0 多 local).

Task carries ``target_folder_id`` → worker tools sit on that Folder root;
memory / rules / ``consult_memory`` follow the same folder (not session birth).
Session ``folder_id`` is never rewritten. Distinct local roots may run in the
same turn (one LocalWorkspace + channel per target); ClaimBook only records.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.memory import default_memory_store
from agentcore.memory.injection import load_memory_topics
from agentcore.memory.rules_injection import assemble_turn_rules
from agentcore.runtime.context.workspace_context import (
    build_workspace_context,
    detect_workspace_git,
)
from agentcore.runtime.resolve.prompt import (
    assemble_system_prompt,
    compose_worker_base_prompt,
)
from agentcore.tools.builtin.consult_memory import ConsultMemoryTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

# Honest reject when bare chat (no birth) would park a worker on conv scratch.
NO_TARGET_SCRATCH_GATE_MSG = (
    "当前对话未绑定出生项目，且任务未携带目标项目（target_folder_id）。"
    "禁止默坐会话 scratch 写盘：请先列/解析项目并点名目标，或 ask_user 问清后再派；"
    "也可先建项目再派。"
)


class TargetDesktopError(Exception):
    """Structured prepare-time failure (unknown folder / DB unreachable / …)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class TargetFolderBinding:
    """Resolved Folder row bits needed to build a worker desk."""

    folder_id: str
    name: str
    local_binding: LocalBinding | None


class LocalRootClaimBook:
    """Turn-scoped registry of local ``root_id`` values (C0: never rejects)."""

    def __init__(self) -> None:
        self._roots: set[str] = set()
        self._lock = asyncio.Lock()

    async def try_claim(self, root_id: str) -> bool:
        """Record ``root_id`` for this turn; always allows distinct roots (C0)."""
        async with self._lock:
            self._roots.add(root_id)
            return True

    async def seed_from_backend(self, backend: WorkspaceBackend) -> None:
        """Record the turn's primary local root (if any) before alien desks claim."""
        root = _backend_local_root_id(backend)
        if root:
            await self.try_claim(root)


def effective_target_folder_id(
    raw: Any,
    *,
    default: str | None = None,
) -> str | None:
    """Normalise task ``target_folder_id``; fall back to inherited default."""
    if isinstance(raw, str):
        cleaned = raw.strip()
        if cleaned:
            return cleaned
    if isinstance(default, str):
        cleaned_default = default.strip()
        if cleaned_default:
            return cleaned_default
    return None


def gate_bare_chat_requires_target(
    *,
    session_folder_id: str | None,
    tasks_raw: list[dict[str, Any]],
    default_target_folder_id: str | None = None,
) -> str | None:
    """§4.2b·2b / 改法④A: no birth + no target → reject before drive.

    Returns an error message, or None when the batch may proceed.
    """
    if session_folder_id:
        return None
    for item in tasks_raw:
        if not isinstance(item, dict):
            continue
        if effective_target_folder_id(
            item.get("target_folder_id"),
            default=default_target_folder_id,
        ):
            continue
        return NO_TARGET_SCRATCH_GATE_MSG
    return None


async def load_target_folder_binding(
    *,
    folder_id: str,
    user_id: str,
) -> TargetFolderBinding | None:
    """Owner-scoped Folder lookup → binding for ``build_workspace``.

    Returns ``None`` when the folder is missing or not owned (business miss).
    Raises ``TargetDesktopError`` when PostgreSQL is unreachable **or** when
    folders cloud credentials are bound but the cloud HTTP call fails — honest
    failure, no local-cache fallback and no forged ``local_binding``.

    With folders narrow-ticket credentials (sidecar), uses cloud ``GET /folders/{id}``
    instead of the local FolderRepository.
    """
    from agentcore.conversation.scratch import resolve_conversation_local_binding
    from agentcore.folders.credentials import (
        FoldersCloudError,
        cloud_get_folder,
        get_folders_credentials,
    )

    creds = get_folders_credentials()
    if creds is not None:
        try:
            summary = await cloud_get_folder(creds, folder_id=folder_id)
        except FoldersCloudError as e:
            logger.warning(
                "delegate.target_folder_cloud_failed",
                folder_id=folder_id,
                user_id=user_id,
                error=str(e),
                code=e.code,
            )
            raise TargetDesktopError(f"无法绑定目标项目。{e.message}") from e
        if summary is None:
            return None
        binding = resolve_conversation_local_binding(
            local_root_id=summary.get("local_root_id"),
            local_subpath=summary.get("local_subpath"),
            label=str(summary.get("name") or "workspace"),
        )
        return TargetFolderBinding(
            folder_id=str(summary.get("id") or folder_id),
            name=str(summary.get("name") or ""),
            local_binding=binding,
        )

    from agentcore.db.base import async_session_factory
    from agentcore.db.errors import DATABASE_UNAVAILABLE_MESSAGE, is_db_connectivity_error
    from agentcore.db.repositories import FolderRepository

    try:
        async with async_session_factory() as session:
            folder = await FolderRepository(session).get_by_id(folder_id, user_id=user_id)
            if folder is None:
                return None
            binding = resolve_conversation_local_binding(
                local_root_id=folder.local_root_id,
                local_subpath=folder.local_subpath,
                label=folder.name or "workspace",
            )
            return TargetFolderBinding(
                folder_id=folder.id,
                name=folder.name or "",
                local_binding=binding,
            )
    except Exception as e:  # noqa: BLE001 — classify connectivity vs bubble
        if is_db_connectivity_error(e):
            logger.warning(
                "delegate.target_folder_db_unreachable",
                folder_id=folder_id,
                user_id=user_id,
                error=str(e),
            )
            raise TargetDesktopError(
                f"无法绑定目标项目。{DATABASE_UNAVAILABLE_MESSAGE}"
            ) from e
        raise


def build_target_backend(
    *,
    user_id: str,
    folder_id: str,
    conversation_id: str,
    sink: Any,
    local_binding: LocalBinding | None,
) -> WorkspaceBackend:
    """Build a worker desk for ``folder_id`` without touching session binding."""
    return build_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )


def _backend_local_root_id(backend: WorkspaceBackend) -> str | None:
    if getattr(backend, "location", None) != "local":
        return None
    channel = getattr(backend, "_channel", None)
    root_id = getattr(channel, "root_id", None) if channel is not None else None
    if isinstance(root_id, str) and root_id.strip():
        return root_id.strip()
    return None


def _registry_rewire_consult_memory(
    base: ToolRegistry,
    *,
    folder_id: str,
    memory_enabled: bool,
    has_memory_topics: bool,
) -> ToolRegistry:
    """Fresh registry: drop old ``consult_memory``, optionally wire target scope."""
    from agentcore.runtime.runs.executor_shared import _registry_without

    registry = _registry_without(base, "consult_memory")
    if memory_enabled and has_memory_topics:
        registry.register(
            ConsultMemoryTool(store=default_memory_store(), folder_id=folder_id)
        )
    return registry


async def rebuild_worker_prompt_for_target(
    *,
    user_id: str,
    folder_id: str,
    backend: WorkspaceBackend,
    memory_enabled: bool,
    attachment_context: str | None = None,
    desktop_online: bool = False,
    permission_axes: Any = None,
) -> tuple[str, bool]:
    """Reassemble worker system prompt with target-folder rules + workspace facts.

    Returns ``(worker_base_prompt, has_memory_topics)``.
    """
    memory_store = default_memory_store()
    user_rules_markdown, memory_markdown = await assemble_turn_rules(
        memory_store,
        user_id,
        folder_id=folder_id,
        enabled=memory_enabled,
        max_docs=settings.max_instruction_docs,
        max_chars=settings.max_instruction_chars,
    )
    memory_topics = await load_memory_topics(
        memory_store, user_id, folder_id=folder_id, enabled=memory_enabled
    )
    from agentcore.tools.sandbox.exec_languages import resolve_exec_languages

    exec_languages = await resolve_exec_languages(backend)
    git_fact = await detect_workspace_git(backend)
    workspace_facts = build_workspace_context(
        backend,
        desktop_online=desktop_online,
        exec_languages=exec_languages,
        permission_axes=permission_axes,
        git_fact=git_fact,
    )
    shared_base = assemble_system_prompt(
        memory_markdown=memory_markdown,
        user_rules_markdown=user_rules_markdown,
        workspace_context=workspace_facts,
    )
    worker_prompt = compose_worker_base_prompt(
        shared_base,
        memory_topics=memory_topics,
        memory_enabled=memory_enabled,
        attachment_context=attachment_context,
    )
    return worker_prompt, bool(memory_topics)


@dataclass(frozen=True)
class AppliedTargetDesktop:
    """Outputs of applying a target desk onto one worker preparation."""

    tool_ctx: ToolContext
    worker_tools: ToolRegistry
    system_prompt: str
    target_folder_id: str


async def apply_target_desktop(
    *,
    target_folder_id: str,
    session_folder_id: str | None,
    env_system_prompt: str,
    base_tool_context: ToolContext,
    worker_tools: ToolRegistry,
    sink: Any,
    local_root_claims: LocalRootClaimBook | None,
    memory_enabled: bool = True,
    permission_axes: Any = None,
) -> AppliedTargetDesktop:
    """Swap backend + memory scope for a worker whose task named a target Folder.

    No-op path (same as session birth desk) still returns applied bag with the
    existing backend when ``target_folder_id == session_folder_id``.
    """
    # Same desk as birth → keep turn wiring (prefix cache + shared tools).
    if session_folder_id and target_folder_id == session_folder_id:
        return AppliedTargetDesktop(
            tool_ctx=base_tool_context,
            worker_tools=worker_tools,
            system_prompt=env_system_prompt,
            target_folder_id=target_folder_id,
        )

    binding = await load_target_folder_binding(
        folder_id=target_folder_id,
        user_id=base_tool_context.user_id,
    )
    if binding is None:
        raise TargetDesktopError(
            f"目标项目 `{target_folder_id}` 不存在或无权访问；"
            "请重新列/解析项目后再派。"
        )

    backend = build_target_backend(
        user_id=base_tool_context.user_id,
        folder_id=binding.folder_id,
        conversation_id=base_tool_context.conversation_id,
        sink=sink,
        local_binding=binding.local_binding,
    )

    # C0: record local root; never reject a second distinct root (sidecar same).
    target_root = _backend_local_root_id(backend)
    if target_root and local_root_claims is not None:
        await local_root_claims.try_claim(target_root)

    desktop_online = base_tool_context.desktop_channel is not None
    worker_prompt, has_topics = await rebuild_worker_prompt_for_target(
        user_id=base_tool_context.user_id,
        folder_id=binding.folder_id,
        backend=backend,
        memory_enabled=memory_enabled,
        desktop_online=desktop_online,
        permission_axes=permission_axes,
    )
    tools = _registry_rewire_consult_memory(
        worker_tools,
        folder_id=binding.folder_id,
        memory_enabled=memory_enabled,
        has_memory_topics=has_topics,
    )
    from agentcore.workspace.locate import workspace_channel_for_tools

    workspace_channel = workspace_channel_for_tools(
        backend,
        sink=sink,
        conversation_id=base_tool_context.conversation_id,
    )
    tool_ctx = replace(
        base_tool_context,
        backend=backend,
        workspace_channel=workspace_channel,
        shared_workspace=True,
    )
    logger.info(
        "delegate.target_desktop_applied",
        folder_id=binding.folder_id,
        folder_name=binding.name,
        location=getattr(backend, "location", None),
        local=bool(binding.local_binding),
    )
    return AppliedTargetDesktop(
        tool_ctx=tool_ctx,
        worker_tools=tools,
        system_prompt=worker_prompt,
        target_folder_id=binding.folder_id,
    )
