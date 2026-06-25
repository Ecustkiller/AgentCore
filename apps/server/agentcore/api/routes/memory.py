"""Long-term AI memory routes — view / edit / clear + master switch (self-only).

The user's long-term memory is the markdown body of their `ai_maintained` rule file
(Agent记忆与知识系统 §1.4 / §五), today backed by the per-user ``MemoryStore`` on disk
until the cloud file tree lands. The desktop「AI 记忆」surface reads it here and edits
it through the SAME source-agnostic markdown editor the file workbench uses, so the
contract mirrors the workspace edit contract: full text + a CAS ``version`` baseline,
and a write reports a ``conflict`` (instead of clobbering) when the offline
consolidation — or another device — changed the file underneath.

All endpoints are self-only (``AuthUser``): memory is private per-user data. Writes
hold the per-user memory lock (``memory/locks.py``) so a manual save and the offline
consolidation pass can never interleave and lose each other's change.

Two editor surfaces sit on top, both reusing the workspace markdown editor (CAS contract):

- **Legacy combined doc** (``GET/PUT /users/me/memory``): treats the GLOBAL core as ONE
  document — combines 偏好.md + 画像.md on read (``merge_global_core``) and splits on write
  (``split_global_core``), which doubles as the organic 偏好/画像 migration (an old 画像.md
  still holding preference sections splits the first time it is saved). Still carries the
  master switch ``enabled``.
- **Per-leaf surface** (``GET/PUT /users/me/memory/files/{kind}``, P2): one editable leaf
  per (kind, scope) so the「文件」rail can show 偏好 / 画像 (global) and a project's 画像
  separately. ``preferences`` (偏好.md) is GLOBAL-only by invariant; ``profile`` (画像.md)
  honors an optional ``folder_id`` to address a project layer. ``GET …/projects`` lists the
  folder_ids that have project memory so the rail only surfaces a node where there is one.
"""

from enum import StrEnum

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from agentcore.api.dependencies import AuthUser, get_user_repo
from agentcore.db.repositories import UserRepository
from agentcore.memory import (
    CORE_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    default_memory_store,
    memory_version,
    merge_global_core,
    split_global_core,
)
from agentcore.memory.locks import user_memory_lock

router = APIRouter(prefix="/users/me/memory", tags=["memory"])


class MemoryKind(StrEnum):
    """Which always-injected core leaf an editor surface addresses (记忆作用域与画像分层 §四).

    ``preferences`` → 偏好.md (沟通/工作习惯, GLOBAL-only); ``profile`` → 画像.md
    (技术栈/关于用户的事实, global or — with a ``folder_id`` — a project layer).
    """

    preferences = "preferences"
    profile = "profile"


def _resolve_file_scope(kind: MemoryKind, folder_id: str | None) -> tuple[str, str | None]:
    """Map a logical (kind, folder_id) to a concrete (file, scope).

    ``preferences`` is GLOBAL-only by invariant (§1.4 — preferences are universal, never
    copied into a project), so a ``folder_id`` is ignored. ``profile`` is global when
    ``folder_id`` is None, else that project's 画像.md.
    """
    if kind is MemoryKind.preferences:
        return PREFERENCES_MEMORY_FILE, None
    return CORE_MEMORY_FILE, folder_id


class MemoryResponse(BaseModel):
    """The user's memory document + the master switch (the editor's load payload)."""

    content: str
    # Content-addressed CAS tag (memory/store.py ``memory_version``); the client sends
    # it back as the write baseline so a stale overwrite is caught, not silently lost.
    version: str
    enabled: bool


class MemoryWriteRequest(BaseModel):
    content: str
    # The version the edit was based on. ``None`` writes unconditionally (used by
    # "清空记忆" / "仍然覆盖"); a non-null value that no longer matches → 200 conflict.
    baseline: str | None = None


class MemoryWriteResult(BaseModel):
    ok: bool
    version: str
    conflict: bool = False


class MemoryEnabledRequest(BaseModel):
    enabled: bool = Field(..., description="Long-term memory master switch")


class MemoryFileResponse(BaseModel):
    """One memory leaf's body + its CAS tag (a single editor leaf's load payload)."""

    content: str
    version: str


class MemoryProjectsResponse(BaseModel):
    """folder_ids whose PROJECT memory layer is non-empty (the rail shows a node each)."""

    folders: list[str]


@router.get("", response_model=MemoryResponse)
async def get_my_memory(user: AuthUser) -> MemoryResponse:
    """Load the signed-in user's long-term memory + whether memory is enabled."""
    store = default_memory_store()
    content = merge_global_core(
        await store.load(user.user_id, PREFERENCES_MEMORY_FILE),
        await store.load(user.user_id, CORE_MEMORY_FILE),
    )
    return MemoryResponse(
        content=content, version=memory_version(content), enabled=user.memory_enabled
    )


@router.put("", response_model=MemoryWriteResult)
async def put_my_memory(body: MemoryWriteRequest, user: AuthUser) -> MemoryWriteResult:
    """Write the user's long-term memory back (full-document edit, CAS-guarded).

    Holds the per-user memory lock so the read-compare-write is atomic against the offline
    consolidation pass. A ``baseline`` that no longer matches the current (merged) version
    returns ``ok=False, conflict=True`` with the live version (never a blind overwrite); the
    client then reloads or forces the write with ``baseline=None``. The edited document is
    split back into 偏好.md + 画像.md; the returned version is that of the re-merged result so
    it matches what the next GET serves (split→save→merge normalizes the markdown).
    """
    store = default_memory_store()
    async with user_memory_lock(user.user_id):
        current = merge_global_core(
            await store.load(user.user_id, PREFERENCES_MEMORY_FILE),
            await store.load(user.user_id, CORE_MEMORY_FILE),
        )
        current_version = memory_version(current)
        if body.baseline is not None and body.baseline != current_version:
            return MemoryWriteResult(ok=False, version=current_version, conflict=True)
        files = split_global_core(body.content)
        for file, markdown in files.items():
            if markdown:
                await store.save(user.user_id, file, markdown)
            else:
                # An empty file means that core file has no sections (e.g. all preferences
                # were removed, or "清空记忆"): drop it so it stops being injected.
                await store.delete(user.user_id, file)
        new_content = merge_global_core(
            files[PREFERENCES_MEMORY_FILE], files[CORE_MEMORY_FILE]
        )
    return MemoryWriteResult(ok=True, version=memory_version(new_content))


@router.put("/enabled", response_model=MemoryResponse)
async def set_my_memory_enabled(
    body: MemoryEnabledRequest,
    user: AuthUser,
    users: UserRepository = Depends(get_user_repo),
) -> MemoryResponse:
    """Toggle the long-term memory master switch (off = stop injecting AND growing)."""
    await users.set_memory_enabled(user.user_id, body.enabled)
    store = default_memory_store()
    content = merge_global_core(
        await store.load(user.user_id, PREFERENCES_MEMORY_FILE),
        await store.load(user.user_id, CORE_MEMORY_FILE),
    )
    return MemoryResponse(
        content=content, version=memory_version(content), enabled=body.enabled
    )


@router.get("/projects", response_model=MemoryProjectsResponse)
async def list_my_memory_projects(user: AuthUser) -> MemoryProjectsResponse:
    """List folder_ids that have project-scoped memory (so the「文件」rail can surface them).

    Declared before ``/files/{kind}`` so the static segment wins the route match.
    """
    store = default_memory_store()
    return MemoryProjectsResponse(folders=await store.project_scopes(user.user_id))


@router.get("/files/{kind}", response_model=MemoryFileResponse)
async def get_my_memory_file(
    kind: MemoryKind, user: AuthUser, folder_id: str | None = None
) -> MemoryFileResponse:
    """Load ONE memory leaf — 偏好/画像 (global) or a project's 画像 (with ``folder_id``)."""
    store = default_memory_store()
    file, scope = _resolve_file_scope(kind, folder_id)
    content = await store.load(user.user_id, file, scope=scope)
    return MemoryFileResponse(content=content, version=memory_version(content))


@router.put("/files/{kind}", response_model=MemoryWriteResult)
async def put_my_memory_file(
    kind: MemoryKind,
    body: MemoryWriteRequest,
    user: AuthUser,
    folder_id: str | None = None,
) -> MemoryWriteResult:
    """Write ONE memory leaf back (CAS-guarded; an empty body drops the file).

    Holds the per-user memory lock so the read-compare-write is atomic against the offline
    consolidation pass. A ``baseline`` that no longer matches the leaf's current version
    returns ``ok=False, conflict=True`` (never a blind overwrite). Clearing a leaf (empty
    content) deletes the underlying file so it stops being injected.
    """
    store = default_memory_store()
    file, scope = _resolve_file_scope(kind, folder_id)
    async with user_memory_lock(user.user_id):
        current = await store.load(user.user_id, file, scope=scope)
        current_version = memory_version(current)
        if body.baseline is not None and body.baseline != current_version:
            return MemoryWriteResult(ok=False, version=current_version, conflict=True)
        if body.content:
            await store.save(user.user_id, file, body.content, scope=scope)
        else:
            await store.delete(user.user_id, file, scope=scope)
    return MemoryWriteResult(ok=True, version=memory_version(body.content))
