"""Resolve a conversation to its server-side workspace (cloud mode).

Path policy (双模式工作区设计 §七 / 决策③):

- A conversation **in a folder** shares that folder's workspace — the folder is
  the "project", so work accumulates in one place across its conversations:
  ``<data_dir>/workspaces/<user_id>/<folder_id>/``.
- An **ungrouped** conversation gets its own independent workspace so unrelated
  chats never collide: ``<data_dir>/workspaces/<user_id>/conv/<conversation_id>/``.

User-scoped top segment keeps tenants isolated by directory; the traversal guard
inside ``ServerWorkspace`` then prevents escaping the resolved root. IDs are
server-generated UUIDs (not user input), so they are safe path segments.

This is the single place that maps "which conversation" → "which directory" (for
cloud) and "which conversation" → "which desktop root" (for local);
``conversation/service.py`` calls :func:`build_workspace` and injects the chosen
backend into the pipeline. The server-vs-local fork (双模式工作区 §七, "模式跟着
文件在哪自动走") lives here so tools and the engine stay backend-agnostic.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from agentcore.config import settings
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.ports import ClientRequestBridge
from agentcore.tools.sandbox.protocol import SandboxProvider
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.channel import WorkspaceChannel
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.protocol import WorkspaceBackend
from agentcore.workspace.server import ServerWorkspace

_WORKSPACES_SEGMENT = "workspaces"


def _workspaces_base() -> Path:
    return Path(settings.data_dir) / _WORKSPACES_SEGMENT


def _workspace_relpath(*, user_id: str, folder_id: str | None, conversation_id: str) -> str:
    """The conversation's workspace path relative to the workspaces base (POSIX).

    Single source of the folder-vs-ungrouped branch, shared by the on-disk root
    and the snapshot storage key so they can never drift apart.
    """
    if folder_id:
        return f"{user_id}/{folder_id}"
    return f"{user_id}/conv/{conversation_id}"


# A workspace's stable public id — the addressing token for the first-class
# ``/v1/workspaces/{ws_id}`` API (文件中枢统一 Step 1). It encodes the same
# folder-vs-ungrouped fork as ``_workspace_relpath`` (the folder *is* the project
# space; an ungrouped conversation gets its own), so a id round-trips to exactly
# one workspace directory. ``:`` separates kind from the UUID — a valid single
# URL path segment that UUIDs never contain, so it needs no escaping.
_WORKSPACE_ID_SEP = ":"


@dataclass(frozen=True)
class WorkspaceId:
    """A parsed workspace id: a folder project, or an ungrouped conversation."""

    kind: Literal["folder", "conv"]
    ident: str


def format_workspace_id(*, folder_id: str | None, conversation_id: str) -> str:
    """The public workspace id for a conversation's resolved space.

    Folder-filed conversations share their folder's id (``folder:<folder_id>``);
    ungrouped ones get their own (``conv:<conversation_id>``) — mirroring the
    directory fork so the id and the on-disk root never disagree.
    """
    if folder_id:
        return f"folder{_WORKSPACE_ID_SEP}{folder_id}"
    return f"conv{_WORKSPACE_ID_SEP}{conversation_id}"


def parse_workspace_id(ws_id: str) -> WorkspaceId:
    """Parse a public workspace id, or raise ``ValueError`` if malformed.

    Pure (no DB / owner check): the API layer resolves the ``ident`` against the
    user's folders/conversations for authorization. Rejects unknown kinds and
    empty / slash-bearing idents so a id can address only one path segment.
    """
    kind, sep, ident = ws_id.partition(_WORKSPACE_ID_SEP)
    if not sep or not ident or "/" in ident or kind not in ("folder", "conv"):
        raise ValueError(f"非法工作区 id：{ws_id!r}")
    return WorkspaceId(kind=kind, ident=ident)  # type: ignore[arg-type]


def workspace_has_entries(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> bool:
    """Whether the workspace dir exists and is non-empty — *without* creating it.

    Backs the hub enumeration's F1 filter (未分组空间只在真有文件时才列出, 文件中枢
    统一 §四). Uses the no-create path helper on purpose: resolving via the backend
    would ``mkdir`` an empty dir for every ungrouped conversation we probe.
    """
    root = workspace_root_path(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return root.is_dir() and any(root.iterdir())


def workspace_root_path(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> Path:
    """The workspace directory path for a conversation — without creating it.

    The pure path helper behind :func:`resolve_workspace_root`; retention cleanup
    (决策⑦) needs the location to delete it, where creating-on-resolve would be
    wrong (and would resurrect a dir we are about to purge).
    """
    relpath = _workspace_relpath(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return _workspaces_base() / relpath


def resolve_workspace_root(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> Path:
    """Return (creating if needed) the workspace directory for a conversation."""
    root = workspace_root_path(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    root.mkdir(parents=True, exist_ok=True)
    return root


def workspace_storage_key(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> str:
    """The snapshot storage key for a conversation's workspace.

    Mirrors the on-disk layout under ``data_dir`` (``workspaces/<user>/<folder>``
    or ``workspaces/<user>/conv/<conversation>``) so a snapshot's object-store
    location reads the same as its filesystem location. The StorageProvider adds
    its own top-level prefix (``snapshots/``).
    """
    relpath = _workspace_relpath(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return f"{_WORKSPACES_SEGMENT}/{relpath}"


def build_server_workspace(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    sandbox: SandboxProvider | None = None,
) -> ServerWorkspace:
    """Construct the ``ServerWorkspace`` for a conversation's resolved root."""
    root = resolve_workspace_root(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return ServerWorkspace(root=root, sandbox=sandbox or SubprocessSandbox())


@dataclass(frozen=True)
class LocalBinding:
    """A conversation's binding to a desktop FS root (the local-mode marker).

    ``root_id`` is the desktop-generated handle for an authorized local directory
    (registered in ``apps/desktop/src/main/fs-service.ts``); ``root_label`` is its
    human-readable name, used for relative-path rendering so absolute local paths
    never leak into prompts. The *presence* of a binding is exactly what flips a
    conversation to local mode (§七); its absence means cloud.
    """

    root_id: str
    root_label: str = "workspace"


def build_local_workspace(
    *,
    binding: LocalBinding,
    sink: EventSink,
    conversation_id: str,
    registry: ClientRequestBridge | None = None,
    timeout_seconds: float | None = None,
) -> LocalWorkspace:
    """Construct the ``LocalWorkspace`` for a conversation bound to a desktop root.

    Builds the per-turn ``WorkspaceChannel`` — the generalized approval-gate
    transport — over the live SSE ``sink`` plus the process-wide op registry (the
    same one the resolve endpoint settles), then wraps it. The channel carries
    ``binding.root_id`` so every op the engine issues runs against the right
    authorized directory on the user's machine. State (the suspended op Future)
    lives in the registry, so it must be the *shared* default unless a test injects
    its own.
    """
    channel = WorkspaceChannel(
        sink=sink,
        conversation_id=conversation_id,
        registry=registry or default_interaction_registry(),
        timeout_seconds=(
            settings.workspace_op_timeout_seconds
            if timeout_seconds is None
            else timeout_seconds
        ),
        root_id=binding.root_id,
    )
    return LocalWorkspace(
        channel,
        root_label=binding.root_label,
        execute_timeout_slack=settings.workspace_execute_timeout_slack_seconds,
    )


def resolve_local_binding(
    *,
    folder_id: str | None,
    folder_local_root_id: str | None,
    label: str | None = None,
) -> LocalBinding | None:
    """Resolve a conversation's local-mode binding from its folder's root id.

    The 双模式工作区 §七 rule, in one place: **文件夹 = 工作区**, so a binding lives
    only on the folder. A conversation **in a folder** is local iff that folder is
    bound; a **folderless (裸聊)** conversation has no workspace yet, so it is always
    cloud. The governing scope being unbound (``None``) means cloud. Pure (takes the
    already-fetched ids) so it stays DB-free and unit-testable; callers fetch the
    folder row and pass its ``local_root_id``.
    """
    root_id = folder_local_root_id if folder_id is not None else None
    if not root_id:
        return None
    return LocalBinding(root_id=root_id, root_label=label or "workspace")


def default_workspace_name(title: str | None) -> str:
    """Name for an auto-created workspace when a 裸聊 first produces files (B 懒建).

    Uses the conversation's title so the new folder reads as "this chat's project";
    falls back when the title has not been generated yet (it is async, post-turn).
    """
    name = " ".join((title or "").split())
    return name[:200] if name else "未命名工作区"


def build_workspace(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    sink: EventSink,
    local_binding: LocalBinding | None,
    sandbox: SandboxProvider | None = None,
) -> WorkspaceBackend:
    """Pick a turn's backend: local when bound to a desktop root, else cloud.

    The single fork behind 双模式工作区 §七 ("模式跟着文件在哪自动走"): a resolved
    ``local_binding`` yields a desktop-backed ``LocalWorkspace``; its absence falls
    back to the server-hosted ``ServerWorkspace``. Both satisfy ``WorkspaceBackend``
    (the P0 seam), so the file tools and the engine run unchanged on either — the
    caller only has to decide *which* here, never *how* downstream.
    """
    if local_binding is not None:
        return build_local_workspace(
            binding=local_binding,
            sink=sink,
            conversation_id=conversation_id,
        )
    return build_server_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sandbox=sandbox,
    )
