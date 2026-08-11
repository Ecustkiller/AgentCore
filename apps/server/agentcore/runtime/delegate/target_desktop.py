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
from agentcore.tools.builtin.consult_rule import ConsultRuleTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

# Honest reject when bare chat (no birth) would park a *write* worker on scratch.
# Auto cloud-desk provision covers the empty-hint case; this copy is for residual
# rejects (multi-project same turn, create failure, …) — do not urge create/ask.
NO_TARGET_SCRATCH_GATE_MSG = (
    "写盘任务必须点名目标项目（target_folder_id）；"
    "纯对话/只读可不点名（worker 坐会话 scratch、禁写）。"
    "同回合已涉及多个项目时请各写盘 task 显式点名。"
)

_AUTO_CLOUD_DESK_NAME_MAX = 200
_DEFAULT_AUTO_CLOUD_DESK_NAME = "云项目"

# Identity tip when a bare-chat worker sits on conv scratch with write_scope=none.
SCRATCH_NO_WRITE_IDENTITY_HINT = (
    "本回合坐会话 scratch、禁写盘；写盘须上级带 target_folder_id 重派。"
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


def task_structurally_requires_write_desk(task: dict[str, Any]) -> bool:
    """True when deliverable structurally needs a write desk (no task-body scan).

    Conditions (any): ``form=="files"`` / non-empty string ``artifacts``.
    No deliverable / ``form=prose`` / omit / legacy flags alone → False.
    """
    raw = task.get("deliverable")
    if not isinstance(raw, dict):
        return False
    if raw.get("form") == "files":
        return True
    arts = raw.get("artifacts")
    return isinstance(arts, list) and any(
        isinstance(a, str) and a.strip() for a in arts
    )


def resolve_bare_chat_write_scope(
    *,
    target_folder_id: str | None,
    session_folder_id: str | None,
    base_write_scope: str,
) -> str:
    """Scratch seat (no birth, no target): ``write_scope=none``; keep ``explore_memory``."""
    if target_folder_id or session_folder_id:
        return base_write_scope
    if base_write_scope == "explore_memory":
        return "explore_memory"
    return "none"


def format_bare_chat_no_target_error(missing_tasks: list[dict[str, Any]]) -> str:
    """Actionable bare-chat gate copy: constant prefix + missing-task skeleton.

    Shared by root ``DelegateTool.execute`` and replan ``apply_replan`` / supervised
    via ``gate_bare_chat_requires_target``. Lists every *write-desk* task lacking a
    valid ``target_folder_id`` (role / optional id / missing-target mark only —
    no task body).
    """
    parts: list[str] = []
    for item in missing_tasks:
        bits: list[str] = []
        role = item.get("role")
        if isinstance(role, str) and role.strip():
            bits.append(f"role={role.strip()}")
        else:
            bits.append("role=?")
        rid = item.get("id")
        if isinstance(rid, str) and rid.strip():
            bits.append(f"id={rid.strip()}")
        bits.append("缺 target_folder_id")
        parts.append("{" + ", ".join(bits) + "}")
    dynamic = "；".join(parts) if parts else "{role=?, 缺 target_folder_id}"
    return f"{NO_TARGET_SCRATCH_GATE_MSG} 缺目标任务：{dynamic}"


def gate_bare_chat_requires_target(
    *,
    session_folder_id: str | None,
    tasks_raw: list[dict[str, Any]],
    default_target_folder_id: str | None = None,
) -> str | None:
    """方案 C: no birth + write-desk task without target → reject before drive.

    Birth desk always passes. Pure chat / readonly (no write deliverable) may omit
    ``target_folder_id`` (worker sits scratch, ``write_scope=none``). Still rejects
    the whole batch when any write-desk task lacks an effective target.

    Callers should run :func:`ensure_bare_chat_auto_cloud_desk` first so bare chat
    with no unique turn hint can silently mint a cloud desk.
    """
    if session_folder_id:
        return None
    missing: list[dict[str, Any]] = []
    for item in tasks_raw:
        if not isinstance(item, dict):
            continue
        if effective_target_folder_id(
            item.get("target_folder_id"),
            default=default_target_folder_id,
        ):
            continue
        if not task_structurally_requires_write_desk(item):
            continue
        missing.append(item)
    if not missing:
        return None
    return format_bare_chat_no_target_error(missing)


def _auto_cloud_desk_name(
    *,
    conversation_title: str | None,
    user_message: str | None,
) -> str:
    title = (conversation_title or "").strip()
    if title:
        return title[:_AUTO_CLOUD_DESK_NAME_MAX]
    preview = " ".join((user_message or "").split()).strip()
    if preview:
        return preview[:_AUTO_CLOUD_DESK_NAME_MAX]
    return _DEFAULT_AUTO_CLOUD_DESK_NAME


async def _load_conversation_title(
    *,
    user_id: str,
    conversation_id: str | None,
) -> str | None:
    if not conversation_id or not user_id:
        return None
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import ConversationRepository

        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(
                conversation_id, user_id=user_id
            )
        if conv is None:
            return None
        title = getattr(conv, "title", None)
        if isinstance(title, str) and title.strip():
            return title.strip()
    except Exception:  # noqa: BLE001 — title is best-effort for naming only
        logger.debug(
            "delegate.auto_cloud_desk_title_lookup_failed",
            conversation_id=conversation_id,
            exc_info=True,
        )
    return None


def _bare_chat_write_tasks_need_target(
    *,
    session_folder_id: str | None,
    tasks_raw: list[dict[str, Any]],
    default_target_folder_id: str | None,
) -> bool:
    """True when gate would reject (no birth + write desk lacking effective target)."""
    return (
        gate_bare_chat_requires_target(
            session_folder_id=session_folder_id,
            tasks_raw=tasks_raw,
            default_target_folder_id=default_target_folder_id,
        )
        is not None
    )


async def ensure_bare_chat_auto_cloud_desk(
    *,
    session_folder_id: str | None,
    tasks_raw: list[dict[str, Any]],
    default_target_folder_id: str | None,
    turn_target_desk: Any,
    user_id: str,
    conversation_id: str | None = None,
    user_message: str | None = None,
    conversation_title: str | None = None,
) -> str | None:
    """Silently create a cloud desk for bare-chat write tasks lacking a target.

    Trigger: no session ``folder_id`` + structural write-desk task + no effective
    target + no unique ``turn_target_desk``. Only cloud; never rewrites conversation
    ``folder_id``. At most once per turn (``auto_cloud_provisioned``). Does not ask
    the user. Returns provisioned folder id, or ``None`` when skipped / failed.
    """
    if session_folder_id:
        return None
    if not user_id:
        return None
    if not _bare_chat_write_tasks_need_target(
        session_folder_id=session_folder_id,
        tasks_raw=tasks_raw if isinstance(tasks_raw, list) else [],
        default_target_folder_id=default_target_folder_id,
    ):
        return None
    if turn_target_desk is None:
        return None
    if getattr(turn_target_desk, "auto_cloud_provisioned", False):
        return None
    # Multi-project same turn already cleared the unique hint — do not mint a third.
    seen = getattr(turn_target_desk, "_seen", None)
    if isinstance(seen, set) and seen and not getattr(turn_target_desk, "folder_id", None):
        return None

    turn_target_desk.auto_cloud_provisioned = True
    title = conversation_title
    if not (isinstance(title, str) and title.strip()):
        title = await _load_conversation_title(
            user_id=user_id, conversation_id=conversation_id
        )
    name = _auto_cloud_desk_name(
        conversation_title=title, user_message=user_message
    )
    try:
        from agentcore.tools.builtin.projects import create_cloud_folder

        project = await create_cloud_folder(user_id=user_id, name=name)
    except Exception as e:  # noqa: BLE001 — fall through to gate reject
        logger.warning(
            "delegate.auto_cloud_desk_provision_failed",
            user_id=user_id,
            conversation_id=conversation_id,
            error=str(e),
        )
        return None

    folder_id = project.get("id") if isinstance(project, dict) else None
    if not isinstance(folder_id, str) or not folder_id.strip():
        logger.warning(
            "delegate.auto_cloud_desk_provision_failed",
            user_id=user_id,
            conversation_id=conversation_id,
            error="missing folder id",
        )
        return None
    folder_id = folder_id.strip()
    turn_target_desk.note_folder(folder_id)
    logger.info(
        "delegate.auto_cloud_desk_provisioned",
        folder_id=folder_id,
        name=name,
        conversation_id=conversation_id,
        conversation_untouched=True,
    )
    return folder_id


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


async def lookup_folder_display_names(
    folder_ids: set[str],
    *,
    user_id: str,
) -> dict[str, str]:
    """Soft owner-scoped Folder id → display name map for kickoff card projection.

    Reuses :func:`load_target_folder_binding` (cloud ticket / local DB). Misses and
    connectivity failures are omitted from the map — callers stamp a fallback label.
    Never raises; kickoff must not block on name resolution.
    """
    cleaned = {fid.strip() for fid in folder_ids if isinstance(fid, str) and fid.strip()}
    uid = (user_id or "").strip()
    if not cleaned or not uid:
        return {}

    async def _one(fid: str) -> tuple[str, str] | None:
        try:
            binding = await load_target_folder_binding(folder_id=fid, user_id=uid)
        except TargetDesktopError:
            return None
        except Exception:  # noqa: BLE001 — soft: never fail kickoff on name lookup
            logger.warning(
                "delegate.folder_display_name_failed",
                folder_id=fid,
                user_id=uid,
            )
            return None
        if binding is None:
            return None
        return fid, binding.name or ""

    pairs = await asyncio.gather(*(_one(fid) for fid in cleaned))
    out: dict[str, str] = {}
    for item in pairs:
        if item is None:
            continue
        fid, name = item
        out[fid] = name
    return out


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


def _registry_rewire_consult_tools(
    base: ToolRegistry,
    *,
    folder_id: str,
    memory_enabled: bool,
    has_memory_topics: bool,
    has_on_demand_rules: bool,
) -> ToolRegistry:
    """Fresh registry: drop old consult_* tools, optionally wire target scope."""
    from agentcore.runtime.runs.executor.shared import _registry_without

    registry = _registry_without(base, "consult_memory")
    registry = _registry_without(registry, "consult_rule")
    if memory_enabled and has_memory_topics:
        registry.register(
            ConsultMemoryTool(store=default_memory_store(), folder_id=folder_id)
        )
    if has_on_demand_rules:
        registry.register(ConsultRuleTool(folder_id=folder_id))
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
) -> tuple[str, bool, bool]:
    """Reassemble worker system prompt with target-folder rules + workspace facts.

    Returns ``(worker_base_prompt, has_memory_topics, has_on_demand_rules)``.
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
    from agentcore.memory import load_on_demand_user_rules

    on_demand_rules = await load_on_demand_user_rules(user_id, folder_id=folder_id)
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
        on_demand_rules=on_demand_rules,
        attachment_context=attachment_context,
    )
    return worker_prompt, bool(memory_topics), bool(on_demand_rules)


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
    worker_prompt, has_topics, has_rules = await rebuild_worker_prompt_for_target(
        user_id=base_tool_context.user_id,
        folder_id=binding.folder_id,
        backend=backend,
        memory_enabled=memory_enabled,
        desktop_online=desktop_online,
        permission_axes=permission_axes,
    )
    tools = _registry_rewire_consult_tools(
        worker_tools,
        folder_id=binding.folder_id,
        memory_enabled=memory_enabled,
        has_memory_topics=has_topics,
        has_on_demand_rules=has_rules,
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
