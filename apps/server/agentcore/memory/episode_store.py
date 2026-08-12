"""Dual-path store for consolidation-pipeline state (local DB ↔ account cloud).

Episodic digests and per-scope sidecar (formerly ``情景/*.md`` + ``_memory_meta.json``
in the documents tree) live in ``memory_episodes`` / ``memory_scope_states``. When the
sidecar turn binds an account ticket and this store has no request session, ops call
``/v1/account/memory/episodes/*`` and ``/v1/account/memory/scope-state/*``. Bound-session
DI (cloud API handlers) always stays on the in-process DB.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories.memory_pipeline import MemoryPipelineRepository
from agentcore.memory.store import MemoryScope

logger = get_logger(__name__)


@dataclass
class ScopeMemoryMeta:
    """Per-(user, scope) sidecar: last semantic success + explore fingerprint fields.

    Digestion is tracked per-episode (``digested_at``), not as an id set here.
    """

    last_semantic_at: datetime | None
    explore_workspace_key: str | None = None
    explore_fingerprint: str | None = None
    explore_fingerprint_dirty: bool = False


@dataclass(frozen=True)
class EpisodeRecord:
    """One undigested (or any) episodic session summary."""

    id: str
    conversation_id: str
    summary: str
    created_at: str  # ISO
    actions_json: str = ""


class EpisodeStore(Protocol):
    """Loads/saves episodic digests + scope state for one (user, scope)."""

    async def append_episode(
        self,
        user_id: str,
        *,
        conversation_id: str,
        summary: str,
        scope: MemoryScope = None,
        actions_json: str = "",
        episode_id: str | None = None,
        created_at: datetime | None = None,
    ) -> EpisodeRecord: ...

    async def list_undigested(
        self, user_id: str, *, scope: MemoryScope = None
    ) -> list[EpisodeRecord]: ...

    async def mark_digested(
        self,
        user_id: str,
        episode_ids: list[str],
        *,
        scope: MemoryScope = None,
        consolidated_at: datetime | None = None,
    ) -> None: ...

    async def load_scope_meta(
        self, user_id: str, *, scope: MemoryScope = None
    ) -> ScopeMemoryMeta: ...

    async def save_scope_meta(
        self,
        user_id: str,
        meta: ScopeMemoryMeta,
        *,
        scope: MemoryScope = None,
    ) -> None: ...

    async def purge_digested(
        self,
        *,
        older_than_days: int = 30,
        user_id: str | None = None,
    ) -> int: ...


def _row_to_record(row) -> EpisodeRecord:
    created = row.created_at
    if isinstance(created, datetime):
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        created_iso = created.astimezone(UTC).isoformat()
    else:
        created_iso = str(created)
    return EpisodeRecord(
        id=row.id,
        conversation_id=str(row.conversation_id or ""),
        summary=row.summary or "",
        created_at=created_iso,
        actions_json=row.actions_json or "",
    )


def _row_to_meta(row) -> ScopeMemoryMeta:
    if row is None:
        return ScopeMemoryMeta(last_semantic_at=None)
    last = row.last_semantic_at
    if isinstance(last, datetime) and last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    return ScopeMemoryMeta(
        last_semantic_at=last,
        explore_workspace_key=row.explore_workspace_key,
        explore_fingerprint=row.explore_fingerprint,
        explore_fingerprint_dirty=bool(row.explore_fingerprint_dirty),
    )


class DbEpisodeStore:
    """DB-backed :class:`EpisodeStore` with optional account-cloud dual path."""

    def __init__(self, session: AsyncSession | None = None) -> None:
        self._session = session

    def _account_cloud_creds(self):
        if self._session is not None:
            return None
        from agentcore.account.credentials import get_account_credentials

        return get_account_credentials()

    def _prepare_cache_only_snapshot(self, user_id: str):
        from agentcore.memory.account_prepare_cache import (
            prepare_reads_cache_only,
            snapshot_for_prepare_store_read,
        )

        if not prepare_reads_cache_only.get():
            return False, None
        return True, snapshot_for_prepare_store_read(user_id)

    @asynccontextmanager
    async def _repo(self) -> AsyncIterator[MemoryPipelineRepository]:
        if self._session is not None:
            yield MemoryPipelineRepository(self._session)
        else:
            async with async_session_factory() as session:
                yield MemoryPipelineRepository(session)

    async def append_episode(
        self,
        user_id: str,
        *,
        conversation_id: str,
        summary: str,
        scope: MemoryScope = None,
        actions_json: str = "",
        episode_id: str | None = None,
        created_at: datetime | None = None,
    ) -> EpisodeRecord:
        import uuid

        creds = self._account_cloud_creds()
        if creds is not None:
            from agentcore.account.credentials import cloud_memory_episode_append

            data = await cloud_memory_episode_append(
                creds,
                scope=scope,
                conversation_id=conversation_id,
                summary=summary,
                actions_json=actions_json,
                episode_id=episode_id,
                created_at=created_at.isoformat() if created_at else None,
            )
            return EpisodeRecord(
                id=str(data.get("id") or ""),
                conversation_id=str(data.get("conversation_id") or conversation_id),
                summary=str(data.get("summary") or summary),
                created_at=str(data.get("created_at") or datetime.now(UTC).isoformat()),
                actions_json=str(data.get("actions_json") or actions_json or ""),
            )

        eid = episode_id or uuid.uuid4().hex
        stamp = created_at or datetime.now(UTC)
        async with self._repo() as repo:
            row = await repo.insert_episode(
                episode_id=eid,
                user_id=user_id,
                folder_id=scope,
                conversation_id=conversation_id,
                summary=summary,
                actions_json=actions_json,
                created_at=stamp,
            )
        return _row_to_record(row)

    async def list_undigested(
        self, user_id: str, *, scope: MemoryScope = None
    ) -> list[EpisodeRecord]:
        creds = self._account_cloud_creds()
        if creds is not None:
            try:
                from agentcore.account.credentials import cloud_memory_episodes_list_undigested

                items = await cloud_memory_episodes_list_undigested(creds, scope=scope)
            except Exception as e:  # noqa: BLE001 - never break consolidation on read miss
                logger.warning("memory.episodes_list_failed", user_id=user_id, error=str(e))
                return []
            out: list[EpisodeRecord] = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                out.append(
                    EpisodeRecord(
                        id=str(item.get("id") or ""),
                        conversation_id=str(item.get("conversation_id") or ""),
                        summary=str(item.get("summary") or ""),
                        created_at=str(item.get("created_at") or ""),
                        actions_json=str(item.get("actions_json") or ""),
                    )
                )
            out.sort(key=lambda r: r.created_at)
            return out
        async with self._repo() as repo:
            rows = await repo.list_undigested(user_id, scope)
        return [_row_to_record(r) for r in rows]

    async def mark_digested(
        self,
        user_id: str,
        episode_ids: list[str],
        *,
        scope: MemoryScope = None,
        consolidated_at: datetime | None = None,
    ) -> None:
        if not episode_ids and consolidated_at is None:
            return
        stamp = consolidated_at or datetime.now(UTC)
        creds = self._account_cloud_creds()
        if creds is not None:
            from agentcore.account.credentials import cloud_memory_episodes_mark_digested

            await cloud_memory_episodes_mark_digested(
                creds,
                scope=scope,
                episode_ids=episode_ids,
                consolidated_at=stamp.isoformat(),
            )
            return
        async with self._repo() as repo:
            if episode_ids:
                await repo.mark_digested(
                    user_id, scope, episode_ids, digested_at=stamp, commit=False
                )
            await repo.upsert_scope_state(
                user_id, scope, last_semantic_at=stamp, commit=True
            )

    async def load_scope_meta(
        self, user_id: str, *, scope: MemoryScope = None
    ) -> ScopeMemoryMeta:
        creds = self._account_cloud_creds()
        if creds is not None:
            cache_only, snapshot = self._prepare_cache_only_snapshot(user_id)
            if cache_only:
                if snapshot is None:
                    return ScopeMemoryMeta(last_semantic_at=None)
                from agentcore.memory.account_prepare_cache import scope_meta_from_snapshot

                return scope_meta_from_snapshot(snapshot, scope=scope)
            try:
                from agentcore.account.credentials import cloud_memory_scope_state_get

                data = await cloud_memory_scope_state_get(creds, scope=scope)
            except Exception as e:  # noqa: BLE001
                logger.warning("memory.scope_state_load_failed", user_id=user_id, error=str(e))
                return ScopeMemoryMeta(last_semantic_at=None)
            return _parse_scope_state_payload(data)
        async with self._repo() as repo:
            row = await repo.get_scope_state(user_id, scope)
        return _row_to_meta(row)

    async def save_scope_meta(
        self,
        user_id: str,
        meta: ScopeMemoryMeta,
        *,
        scope: MemoryScope = None,
    ) -> None:
        creds = self._account_cloud_creds()
        if creds is not None:
            from agentcore.memory.account_prepare_cache import prepare_reads_cache_only

            if prepare_reads_cache_only.get():
                logger.info(
                    "memory.scope_state_save_skipped_prepare_cache_only",
                    user_id=user_id,
                    scope=scope or "global",
                )
                return
            from agentcore.account.credentials import cloud_memory_scope_state_save

            await cloud_memory_scope_state_save(
                creds,
                scope=scope,
                last_semantic_at=(
                    meta.last_semantic_at.astimezone(UTC).isoformat()
                    if meta.last_semantic_at
                    else None
                ),
                explore_workspace_key=meta.explore_workspace_key,
                explore_fingerprint=meta.explore_fingerprint,
                explore_fingerprint_dirty=meta.explore_fingerprint_dirty,
            )
            return
        async with self._repo() as repo:
            await repo.upsert_scope_state(
                user_id,
                scope,
                last_semantic_at=meta.last_semantic_at,
                explore_workspace_key=meta.explore_workspace_key,
                explore_fingerprint=meta.explore_fingerprint,
                explore_fingerprint_dirty=meta.explore_fingerprint_dirty,
            )

    async def purge_digested(
        self,
        *,
        older_than_days: int = 30,
        user_id: str | None = None,
    ) -> int:
        creds = self._account_cloud_creds()
        if creds is not None:
            from agentcore.account.credentials import cloud_memory_episodes_purge

            return await cloud_memory_episodes_purge(
                creds, older_than_days=older_than_days
            )
        async with self._repo() as repo:
            return await repo.purge_digested_older_than(
                older_than_days=older_than_days, user_id=user_id
            )


def _parse_scope_state_payload(data: dict) -> ScopeMemoryMeta:
    last_raw = data.get("last_semantic_at")
    last: datetime | None = None
    if isinstance(last_raw, str) and last_raw.strip():
        try:
            last = datetime.fromisoformat(last_raw.replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=UTC)
        except ValueError:
            last = None
    key_raw = data.get("explore_workspace_key")
    key = str(key_raw).strip() if isinstance(key_raw, str) and key_raw.strip() else None
    fp_raw = data.get("explore_fingerprint")
    fingerprint = (
        str(fp_raw).strip() if isinstance(fp_raw, str) and fp_raw.strip() else None
    )
    return ScopeMemoryMeta(
        last_semantic_at=last,
        explore_workspace_key=key,
        explore_fingerprint=fingerprint,
        explore_fingerprint_dirty=bool(data.get("explore_fingerprint_dirty")),
    )


class InMemoryEpisodeStore:
    """Process-local EpisodeStore for unit tests (no DB / no cloud)."""

    def __init__(self) -> None:
        self._episodes: dict[tuple[str, str | None], list[EpisodeRecord]] = {}
        self._digested: dict[tuple[str, str | None], set[str]] = {}
        self._meta: dict[tuple[str, str | None], ScopeMemoryMeta] = {}
        self._digested_at: dict[str, datetime] = {}

    def _key(self, user_id: str, scope: MemoryScope) -> tuple[str, str | None]:
        return (user_id, scope)

    async def append_episode(
        self,
        user_id: str,
        *,
        conversation_id: str,
        summary: str,
        scope: MemoryScope = None,
        actions_json: str = "",
        episode_id: str | None = None,
        created_at: datetime | None = None,
    ) -> EpisodeRecord:
        import uuid

        eid = episode_id or uuid.uuid4().hex
        stamp = created_at or datetime.now(UTC)
        rec = EpisodeRecord(
            id=eid,
            conversation_id=conversation_id,
            summary=summary,
            created_at=stamp.astimezone(UTC).isoformat(),
            actions_json=actions_json or "",
        )
        self._episodes.setdefault(self._key(user_id, scope), []).append(rec)
        return rec

    async def list_undigested(
        self, user_id: str, *, scope: MemoryScope = None
    ) -> list[EpisodeRecord]:
        digested = self._digested.get(self._key(user_id, scope), set())
        out = [
            r
            for r in self._episodes.get(self._key(user_id, scope), [])
            if r.id not in digested
        ]
        out.sort(key=lambda r: r.created_at)
        return out

    async def mark_digested(
        self,
        user_id: str,
        episode_ids: list[str],
        *,
        scope: MemoryScope = None,
        consolidated_at: datetime | None = None,
    ) -> None:
        stamp = consolidated_at or datetime.now(UTC)
        key = self._key(user_id, scope)
        self._digested.setdefault(key, set()).update(episode_ids)
        for eid in episode_ids:
            self._digested_at[eid] = stamp
        meta = self._meta.get(key) or ScopeMemoryMeta(last_semantic_at=None)
        meta.last_semantic_at = stamp
        self._meta[key] = meta

    async def load_scope_meta(
        self, user_id: str, *, scope: MemoryScope = None
    ) -> ScopeMemoryMeta:
        return self._meta.get(self._key(user_id, scope)) or ScopeMemoryMeta(
            last_semantic_at=None
        )

    async def save_scope_meta(
        self,
        user_id: str,
        meta: ScopeMemoryMeta,
        *,
        scope: MemoryScope = None,
    ) -> None:
        self._meta[self._key(user_id, scope)] = ScopeMemoryMeta(
            last_semantic_at=meta.last_semantic_at,
            explore_workspace_key=meta.explore_workspace_key,
            explore_fingerprint=meta.explore_fingerprint,
            explore_fingerprint_dirty=meta.explore_fingerprint_dirty,
        )

    async def purge_digested(
        self,
        *,
        older_than_days: int = 30,
        user_id: str | None = None,
    ) -> int:
        from datetime import timedelta

        if older_than_days <= 0:
            return 0
        cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
        removed = 0
        for key, eps in list(self._episodes.items()):
            if user_id is not None and key[0] != user_id:
                continue
            keep: list[EpisodeRecord] = []
            digested = self._digested.get(key, set())
            for ep in eps:
                stamped = self._digested_at.get(ep.id)
                if ep.id in digested and stamped is not None and stamped < cutoff:
                    removed += 1
                    digested.discard(ep.id)
                    self._digested_at.pop(ep.id, None)
                    continue
                keep.append(ep)
            self._episodes[key] = keep
        return removed


def default_episode_store() -> EpisodeStore:
    """Process default: unbound DbEpisodeStore (opens its own session / cloud path)."""
    return DbEpisodeStore()
