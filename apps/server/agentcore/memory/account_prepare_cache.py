"""Process-local rules/memory snapshot for account-ticketed prepare/resume.

When sidecar turns bind account credentials, prepare must not serially await
``/rules/list`` / ``memory/list|load``. Warm (non-turn) fetches once, seeds this
cache; prepare/resume read ``cache_only`` (miss → empty injection).

Mirrors MCP discover cache (``tools/mcp/wire.py``): success TTL ~300s; degraded
entries use a shorter negative TTL.

During prepare→assemble, ``prepare_reads_cache_only`` is bound so
``DocumentMemoryStore`` list/load/save also stay on this snapshot (no sync cloud).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from agentcore.account.credentials import (
    AccountCredentials,
    cloud_list_user_rules,
    cloud_memory_list,
    cloud_memory_load,
)
from agentcore.core.logging import get_logger
from agentcore.memory.injection import MemoryTopic
from agentcore.memory.store import (
    ALWAYS_MEMORY_FILES,
    CORE_MEMORY_FILE,
    MEMORY_META_FILE,
    NAVIGATION_MEMORY_FILE,
    is_topic_path,
    topic_slug,
)
from agentcore.memory.user_memory import topic_summary_line

logger = get_logger(__name__)

_CACHE_TTL_SECONDS = 300.0
_NEGATIVE_CACHE_TTL_SECONDS = 30.0

# Bound True for the prepare→assemble window (see pipeline/run.py). When set,
# DocumentMemoryStore ticketed reads use this snapshot only (miss → empty);
# saves no-op so explore meta drift cannot block TTFT on cloud writes.
prepare_reads_cache_only: ContextVar[bool] = ContextVar(
    "prepare_reads_cache_only", default=False
)
# Conversation folder_id used as the warm-cache key while cache_only is on
# (snapshot holds both global ``""`` and project bodies under one seed).
prepare_account_folder_id: ContextVar[str | None] = ContextVar(
    "prepare_account_folder_id", default=None
)


@dataclass(frozen=True)
class AccountPrepareSnapshot:
    """One warm fetch covering prepare's rules + memory injection needs."""

    rules_payload: Mapping[str, Any] = field(default_factory=dict)
    # (scope_key, path) → markdown; scope_key "" = global, else folder_id.
    memory_bodies: Mapping[tuple[str, str], str] = field(default_factory=dict)
    memory_topics: tuple[MemoryTopic, ...] = ()
    degraded: bool = False


@dataclass(frozen=True)
class _CacheEntry:
    snapshot: AccountPrepareSnapshot
    expires_at: float


_cache: dict[tuple[str, str | None], _CacheEntry] = {}


def clear_account_rules_memory_cache() -> None:
    """Drop process-local prepare cache (tests / forced refresh)."""
    _cache.clear()


def _cache_key(user_id: str, folder_id: str | None) -> tuple[str, str | None]:
    return ((user_id or "").strip(), folder_id)


def get_account_rules_memory_snapshot(
    user_id: str,
    folder_id: str | None,
) -> AccountPrepareSnapshot | None:
    """Read process cache only. Miss → None (caller injects empty; no cloud)."""
    key = _cache_key(user_id, folder_id)
    now = time.monotonic()
    entry = _cache.get(key)
    if entry is not None and entry.expires_at > now:
        logger.info(
            "account.rules_memory_cache_hit",
            user_id=key[0] or None,
            folder_id=folder_id,
            degraded=entry.snapshot.degraded,
            topic_count=len(entry.snapshot.memory_topics),
        )
        return entry.snapshot
    logger.info(
        "account.rules_memory_cache_miss",
        user_id=key[0] or None,
        folder_id=folder_id,
    )
    return None


def seed_account_rules_memory_cache(
    user_id: str,
    folder_id: str | None,
    snapshot: AccountPrepareSnapshot,
) -> None:
    """Write an already-fetched snapshot into the process cache (non-turn warm)."""
    uid = (user_id or "").strip()
    if not uid:
        raise ValueError("user_id is required to seed account rules/memory cache")
    ttl = (
        _NEGATIVE_CACHE_TTL_SECONDS
        if snapshot.degraded
        else _CACHE_TTL_SECONDS
    )
    key = _cache_key(uid, folder_id)
    _cache[key] = _CacheEntry(
        snapshot=snapshot, expires_at=time.monotonic() + ttl
    )
    logger.info(
        "account.rules_memory_cache_seed",
        user_id=uid,
        folder_id=folder_id,
        degraded=snapshot.degraded,
        topic_count=len(snapshot.memory_topics),
        memory_file_count=len(snapshot.memory_bodies),
        ttl_seconds=ttl,
    )


def _scope_key(scope: str | None) -> str:
    return "" if scope is None else scope


def _wanted_paths(files: list[dict[str, Any]], *, scope: str | None) -> list[str]:
    """Always-injected + topic paths + meta sidecar for explore/fingerprint.

    ``MEMORY_META_FILE`` is forced even when cloud ``memory/list`` omits it
    (json sidecar, not ``*.md``). Project always already includes ``画像.md``.
    """
    wanted: list[str] = []
    seen: set[str] = set()
    always = (
        set(ALWAYS_MEMORY_FILES)
        if scope is None
        else {CORE_MEMORY_FILE, NAVIGATION_MEMORY_FILE}
    )
    for item in files:
        path = str(item.get("path") or "")
        if not path or path in seen:
            continue
        if path in always or path == MEMORY_META_FILE or is_topic_path(path):
            seen.add(path)
            wanted.append(path)
    if MEMORY_META_FILE not in seen:
        wanted.append(MEMORY_META_FILE)
    return wanted


async def _fetch_scope_bodies(
    creds: AccountCredentials,
    scope: str | None,
) -> tuple[dict[tuple[str, str], str], list[tuple[str, str]]]:
    """List+load one memory scope → bodies + (slug, summary) topic pairs."""
    files = await cloud_memory_list(creds, scope=scope)
    paths = _wanted_paths(files, scope=scope)
    if not paths:
        return {}, []

    async def _one(path: str) -> tuple[str, str]:
        body = await cloud_memory_load(creds, path=path, scope=scope)
        return path, body

    loaded = await asyncio.gather(*(_one(p) for p in paths))
    sk = _scope_key(scope)
    bodies: dict[tuple[str, str], str] = {}
    topics: list[tuple[str, str]] = []
    for path, body in loaded:
        bodies[(sk, path)] = body
        if is_topic_path(path):
            topics.append((topic_slug(path), topic_summary_line(body)))
    return bodies, topics


def _merge_topics(
    global_topics: list[tuple[str, str]],
    project_topics: list[tuple[str, str]],
) -> tuple[MemoryTopic, ...]:
    summaries: dict[str, str] = {}
    for name, summary in global_topics:
        summaries.setdefault(name, summary)
    for name, summary in project_topics:
        summaries.setdefault(name, summary)
    return tuple(
        MemoryTopic(name=name, summary=summaries[name]) for name in sorted(summaries)
    )


async def warm_account_rules_memory(
    creds: AccountCredentials,
    *,
    user_id: str,
    folder_id: str | None,
) -> AccountPrepareSnapshot:
    """Fetch rules+memory in parallel, seed cache, return snapshot.

    ``/rules/list`` runs once (feeds always + on_demand). Memory scopes list/load
    in parallel; topic summaries are derived from loaded topic bodies.
    """
    uid = (user_id or "").strip()
    if not uid:
        raise ValueError("user_id is required to warm account rules/memory cache")

    rules_coro = cloud_list_user_rules(creds, folder_id=folder_id)
    global_coro = _fetch_scope_bodies(creds, None)
    if folder_id:
        project_coro = _fetch_scope_bodies(creds, folder_id)
        rules_res, global_res, project_res = await asyncio.gather(
            rules_coro, global_coro, project_coro, return_exceptions=True
        )
    else:
        rules_res, global_res = await asyncio.gather(
            rules_coro, global_coro, return_exceptions=True
        )
        project_res = ({}, [])

    degraded = False
    rules_payload: dict[str, Any] = {}
    if isinstance(rules_res, BaseException):
        degraded = True
        logger.warning(
            "account.rules_memory_warm_failed",
            user_id=uid,
            folder_id=folder_id,
            part="rules",
            error=str(rules_res),
        )
    elif isinstance(rules_res, dict):
        rules_payload = dict(rules_res)
    else:
        degraded = True

    memory_bodies: dict[tuple[str, str], str] = {}
    global_topics: list[tuple[str, str]] = []
    project_topics: list[tuple[str, str]] = []

    if isinstance(global_res, BaseException):
        degraded = True
        logger.warning(
            "account.rules_memory_warm_failed",
            user_id=uid,
            folder_id=folder_id,
            part="memory_global",
            error=str(global_res),
        )
    else:
        bodies, topics = global_res  # type: ignore[misc]
        memory_bodies.update(bodies)
        global_topics = topics

    if folder_id:
        if isinstance(project_res, BaseException):
            degraded = True
            logger.warning(
                "account.rules_memory_warm_failed",
                user_id=uid,
                folder_id=folder_id,
                part="memory_project",
                error=str(project_res),
            )
        else:
            bodies, topics = project_res  # type: ignore[misc]
            memory_bodies.update(bodies)
            project_topics = topics

    snapshot = AccountPrepareSnapshot(
        rules_payload=rules_payload,
        memory_bodies=memory_bodies,
        memory_topics=_merge_topics(global_topics, project_topics),
        degraded=degraded,
    )
    seed_account_rules_memory_cache(uid, folder_id, snapshot)
    return snapshot


def memory_body_from_snapshot(
    snapshot: AccountPrepareSnapshot,
    path: str,
    *,
    scope: str | None,
) -> str:
    """Look up one memory file body from a warm snapshot (missing → \"\")."""
    return snapshot.memory_bodies.get((_scope_key(scope), path), "")


def snapshot_for_prepare_store_read(
    user_id: str,
) -> AccountPrepareSnapshot | None:
    """Snapshot for DocumentMemoryStore under ``prepare_reads_cache_only``.

    Uses the conversation ``folder_id`` bound alongside the flag (warm seed key).
    """
    if not prepare_reads_cache_only.get():
        return None
    return get_account_rules_memory_snapshot(
        user_id, prepare_account_folder_id.get()
    )


__all__ = [
    "AccountPrepareSnapshot",
    "clear_account_rules_memory_cache",
    "get_account_rules_memory_snapshot",
    "memory_body_from_snapshot",
    "prepare_account_folder_id",
    "prepare_reads_cache_only",
    "seed_account_rules_memory_cache",
    "snapshot_for_prepare_store_read",
    "warm_account_rules_memory",
]
