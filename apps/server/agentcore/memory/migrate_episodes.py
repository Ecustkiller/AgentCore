"""One-time documents→tables backfill for consolidation-pipeline internal state.

Expand / migrate / contract:
- **expand**: ``memory_episodes`` / ``memory_scope_states`` via Alembic (deploy).
- **migrate**: copy only (documents tree + leftover on-disk ``情景/*.md`` /
  ``_memory_meta.json``) into the tables. Never deletes sources. Per-scope
  all-or-nothing: any parse/insert failure rolls the scope back with no partial
  accounting. Existing ``scope_state`` rows get empty→value field merge.
- **contract** (self-lagged one deploy): soft-delete / unlink a legacy source only
  when (1) its corresponding table row already existed when **this deploy run
  started** and (2) source content matches that row. First deploy therefore
  migrates without deleting; the next deploy clears last round's sources so a
  pin-back to the old image can still read ``情景/*.md``. Granularity is per
  legacy source→row (live episodes without a legacy source are irrelevant).
  Episode ``created_at`` is the dialogue timestamp, not insert time — lag uses a
  pre-run existence preimage of the legacy-corresponding rows instead of a new
  flag table.

Idempotent; recovers digests / explore fingerprints from meta bodies polluted by
``ensure_apply_key`` frontmatter. This module is the **single reader** for legacy
episodic + meta sources (``migrate_documents`` skips them on purpose).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import or_, select

from agentcore.core.logging import get_logger
from agentcore.db.models import Document
from agentcore.db.repositories import DocumentRepository, MemoryPipelineRepository
from agentcore.memory.episode_store import EpisodeRecord
from agentcore.memory.episodic import (
    legacy_digested_ids_from_meta_json,
    parse_legacy_episode_body,
    parse_legacy_scope_meta_json,
)
from agentcore.memory.store import EPISODIC_DIR, MEMORY_META_FILE, is_episodic_path

logger = get_logger(__name__)

_PROJECT_CONTAINER = "_folders"


@dataclass(frozen=True)
class EpisodeMigrationStats:
    scopes_scanned: int
    episodes_migrated: int
    episodes_skipped: int
    metas_migrated: int
    notes_soft_deleted: int
    failed: int
    scopes_contracted: int = 0


@dataclass(frozen=True)
class LegacyTablePreimage:
    """Legacy-corresponding table rows that already existed before this deploy run.

    Built once at run start (before migrate). Contract may delete a source only when
    its row id/key is in this set — that is the one-deploy self-lag.
    """

    episode_ids: frozenset[str] = frozenset()
    # (user_id, folder_id) pairs that already had a scope_state row.
    scope_keys: frozenset[tuple[str, str | None]] = frozenset()


@dataclass
class _EpisodeSource:
    episode_id: str
    body: str
    document: Document | None = None
    disk_path: Path | None = None


@dataclass
class _ScopeBundle:
    user_id: str
    folder_id: str | None
    episodes: dict[str, _EpisodeSource] = field(default_factory=dict)
    meta_body: str | None = None
    meta_document: Document | None = None
    meta_disk_path: Path | None = None


def _parse_created_at(raw: str) -> datetime:
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except ValueError:
        return datetime.now(UTC)


def _coerce_conversation_id(raw: str) -> str:
    conv = (raw or "").strip()
    if not conv:
        return "00000000-0000-0000-0000-000000000000"
    if len(conv) == 32 and "-" not in conv:
        return (
            f"{conv[0:8]}-{conv[8:12]}-{conv[12:16]}-"
            f"{conv[16:20]}-{conv[20:32]}"
        )
    return conv


def _scope_key(user_id: str, folder_id: str | None) -> tuple[str, str | None]:
    return (user_id, folder_id)


def _ensure_bundle(
    scopes: dict[tuple[str, str | None], _ScopeBundle],
    user_id: str,
    folder_id: str | None,
) -> _ScopeBundle:
    key = _scope_key(user_id, folder_id)
    bundle = scopes.get(key)
    if bundle is None:
        bundle = _ScopeBundle(user_id=user_id, folder_id=folder_id)
        scopes[key] = bundle
    return bundle


def _add_episode(
    bundle: _ScopeBundle,
    *,
    episode_id: str,
    body: str,
    document: Document | None = None,
    disk_path: Path | None = None,
) -> None:
    existing = bundle.episodes.get(episode_id)
    if existing is None:
        bundle.episodes[episode_id] = _EpisodeSource(
            episode_id=episode_id, body=body, document=document, disk_path=disk_path
        )
        return
    # Prefer document-tree body when both exist; keep both handles for contract.
    if document is not None and existing.document is None:
        existing.document = document
        existing.body = body
    if disk_path is not None and existing.disk_path is None:
        existing.disk_path = disk_path
    if document is None and existing.document is None and disk_path is not None:
        existing.body = body
        existing.disk_path = disk_path


def _add_meta(
    bundle: _ScopeBundle,
    *,
    body: str,
    document: Document | None = None,
    disk_path: Path | None = None,
) -> None:
    if document is not None:
        bundle.meta_document = document
        bundle.meta_body = body
    if disk_path is not None:
        bundle.meta_disk_path = disk_path
        if bundle.meta_document is None or bundle.meta_body is None:
            bundle.meta_body = body


async def _collect_document_scopes(
    session_factory: Callable,
) -> dict[tuple[str, str | None], _ScopeBundle]:
    scopes: dict[tuple[str, str | None], _ScopeBundle] = {}
    async with session_factory() as session:
        result = await session.execute(
            select(Document.user_id, Document.folder_id)
            .where(
                Document.ai_maintained.is_(True),
                Document.kind == "document",
                Document.deleted_at.is_(None),
                or_(
                    Document.name.startswith(f"{EPISODIC_DIR}/"),
                    Document.name == MEMORY_META_FILE,
                ),
            )
            .distinct()
        )
        scope_pairs = [(str(u), f) for u, f in result.all()]

    for user_id, folder_id in scope_pairs:
        async with session_factory() as session:
            docs = DocumentRepository(session)
            notes = await docs.list_memory_notes(user_id, folder_id)
            bundle = _ensure_bundle(scopes, user_id, folder_id)
            for note in notes:
                if note.name == MEMORY_META_FILE:
                    _add_meta(bundle, body=note.content or "", document=note)
                elif is_episodic_path(note.name):
                    episode_id = note.name[len(EPISODIC_DIR) + 1 :].removesuffix(".md")
                    if episode_id:
                        _add_episode(
                            bundle,
                            episode_id=episode_id,
                            body=note.content or "",
                            document=note,
                        )
    return scopes


def _read_disk_file(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("memory.migrate_episodes_disk_read_failed", path=str(path), error=str(e))
        return None


def _collect_disk_into(
    scopes: dict[tuple[str, str | None], _ScopeBundle],
    *,
    base_dir: Path,
) -> None:
    if not base_dir.exists():
        return
    try:
        user_dirs = [p for p in sorted(base_dir.iterdir()) if p.is_dir()]
    except OSError as e:
        logger.warning("memory.migrate_episodes_disk_scan_failed", base=str(base_dir), error=str(e))
        return

    for user_dir in user_dirs:
        user_id = user_dir.name
        _collect_disk_scope(scopes, user_id=user_id, folder_id=None, scope_dir=user_dir)
        container = user_dir / _PROJECT_CONTAINER
        if not container.is_dir():
            continue
        try:
            folder_dirs = [p for p in sorted(container.iterdir()) if p.is_dir()]
        except OSError as e:
            logger.warning(
                "memory.migrate_episodes_disk_scan_failed",
                path=str(container),
                error=str(e),
            )
            continue
        for scope_dir in folder_dirs:
            _collect_disk_scope(
                scopes, user_id=user_id, folder_id=scope_dir.name, scope_dir=scope_dir
            )


def _collect_disk_scope(
    scopes: dict[tuple[str, str | None], _ScopeBundle],
    *,
    user_id: str,
    folder_id: str | None,
    scope_dir: Path,
) -> None:
    meta_path = scope_dir / MEMORY_META_FILE
    episodic_dir = scope_dir / EPISODIC_DIR
    has_meta = meta_path.is_file()
    episode_files: list[Path] = []
    if episodic_dir.is_dir():
        try:
            episode_files = sorted(
                p for p in episodic_dir.iterdir() if p.is_file() and p.suffix == ".md"
            )
        except OSError as e:
            logger.warning(
                "memory.migrate_episodes_disk_scan_failed",
                path=str(episodic_dir),
                error=str(e),
            )
    if not has_meta and not episode_files:
        return

    bundle = _ensure_bundle(scopes, user_id, folder_id)
    if has_meta:
        body = _read_disk_file(meta_path)
        if body is not None:
            _add_meta(bundle, body=body, disk_path=meta_path)
    for path in episode_files:
        episode_id = path.stem
        if not episode_id:
            continue
        body = _read_disk_file(path)
        if body is None:
            continue
        _add_episode(bundle, episode_id=episode_id, body=body, disk_path=path)


async def collect_legacy_episode_scopes(
    *,
    session_factory: Callable,
    base_dir: str | Path | None = None,
) -> list[_ScopeBundle]:
    """Single reader: document-tree rows ∪ leftover on-disk episodic / meta files."""
    if base_dir is None:
        from agentcore.config import settings

        base_dir = Path(settings.data_dir) / "memory"
    scopes = await _collect_document_scopes(session_factory)
    _collect_disk_into(scopes, base_dir=Path(base_dir))
    return list(scopes.values())


async def _migrate_one_scope(
    bundle: _ScopeBundle,
    session_factory: Callable,
) -> tuple[int, int, int, bool]:
    """Returns (episodes_migrated, episodes_skipped, metas_migrated, ok)."""
    # Fail-fast parse: any bad episode aborts the whole scope with no writes.
    parsed: list[tuple[_EpisodeSource, EpisodeRecord]] = []
    for src in bundle.episodes.values():
        rec = parse_legacy_episode_body(src.episode_id, src.body)
        if rec is None:
            logger.warning(
                "memory.migrate_episode_parse_failed",
                user_id=bundle.user_id,
                folder_id=bundle.folder_id,
                episode_id=src.episode_id,
            )
            return 0, 0, 0, False
        parsed.append((src, rec))

    digested_ids: set[str] = set()
    meta = None
    if bundle.meta_body is not None:
        digested_ids = legacy_digested_ids_from_meta_json(bundle.meta_body)
        meta = parse_legacy_scope_meta_json(bundle.meta_body)

    migrated = skipped = metas = 0
    try:
        async with session_factory() as session:
            pipe = MemoryPipelineRepository(session)
            for src, rec in parsed:
                if await pipe.episode_exists(src.episode_id):
                    skipped += 1
                    continue
                digested_at = datetime.now(UTC) if src.episode_id in digested_ids else None
                await pipe.insert_episode(
                    episode_id=src.episode_id,
                    user_id=bundle.user_id,
                    folder_id=bundle.folder_id,
                    conversation_id=_coerce_conversation_id(rec.conversation_id),
                    summary=rec.summary,
                    actions_json=rec.actions_json,
                    created_at=_parse_created_at(rec.created_at),
                    digested_at=digested_at,
                    commit=False,
                )
                migrated += 1
            if meta is not None:
                await pipe.merge_scope_state_fill_empty(
                    bundle.user_id,
                    bundle.folder_id,
                    last_semantic_at=meta.last_semantic_at,
                    explore_workspace_key=meta.explore_workspace_key,
                    explore_fingerprint=meta.explore_fingerprint,
                    explore_fingerprint_dirty=meta.explore_fingerprint_dirty,
                    commit=False,
                )
                metas = 1
            await session.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "memory.migrate_episodes_scope_failed",
            user_id=bundle.user_id,
            folder_id=bundle.folder_id,
            error=str(e),
        )
        return 0, 0, 0, False
    return migrated, skipped, metas, True


def _meta_fields_consistent(source_body: str, row) -> bool:
    """Source non-empty fields must be present on the row (merge may keep prior values)."""
    meta = parse_legacy_scope_meta_json(source_body)
    if meta.last_semantic_at is not None and row.last_semantic_at is None:
        return False
    if meta.explore_workspace_key and not row.explore_workspace_key:
        return False
    if meta.explore_fingerprint and not row.explore_fingerprint:
        return False
    return not (
        meta.explore_fingerprint_dirty and not bool(row.explore_fingerprint_dirty)
    )


def _episode_content_matches(
    *,
    src: _EpisodeSource,
    user_id: str,
    folder_id: str | None,
    row,
) -> bool:
    rec = parse_legacy_episode_body(src.episode_id, src.body)
    if rec is None or row is None:
        return False
    if (row.summary or "") != rec.summary:
        return False
    if str(row.user_id) != user_id:
        return False
    return row.folder_id == folder_id


async def snapshot_legacy_table_preimage(
    bundles: Iterable[_ScopeBundle],
    session_factory: Callable,
) -> LegacyTablePreimage:
    """Which legacy-corresponding table rows already exist (call before migrate)."""
    episode_ids: set[str] = set()
    scope_keys: set[tuple[str, str | None]] = set()
    async with session_factory() as session:
        pipe = MemoryPipelineRepository(session)
        for bundle in bundles:
            for episode_id in bundle.episodes:
                if await pipe.episode_exists(episode_id):
                    episode_ids.add(episode_id)
            if bundle.meta_body is not None:
                state = await pipe.get_scope_state(bundle.user_id, bundle.folder_id)
                if state is not None:
                    scope_keys.add((bundle.user_id, bundle.folder_id))
    return LegacyTablePreimage(
        episode_ids=frozenset(episode_ids),
        scope_keys=frozenset(scope_keys),
    )


async def _contract_one_scope(
    bundle: _ScopeBundle,
    session_factory: Callable,
    preexisting: LegacyTablePreimage,
) -> tuple[int, bool]:
    """Per-source contract. Returns (deleted_count, hard_fail).

    A source is deleted only when its table row is in ``preexisting`` AND content matches.
    Lag-skipped sources are not failures.
    """
    deleted = 0
    hard_fail = False
    unlink_episodes: list[_EpisodeSource] = []
    unlink_meta = False

    try:
        async with session_factory() as session:
            pipe = MemoryPipelineRepository(session)
            docs = DocumentRepository(session)
            stamp = datetime.now(UTC)

            for src in bundle.episodes.values():
                if src.episode_id not in preexisting.episode_ids:
                    continue
                row = await pipe.get_episode(src.episode_id)
                if not _episode_content_matches(
                    src=src,
                    user_id=bundle.user_id,
                    folder_id=bundle.folder_id,
                    row=row,
                ):
                    hard_fail = True
                    continue
                if src.document is not None:
                    note = await docs.get_memory_note(
                        bundle.user_id,
                        f"{EPISODIC_DIR}/{src.episode_id}.md",
                        bundle.folder_id,
                    )
                    if note is not None:
                        note.deleted_at = stamp
                        deleted += 1
                if src.disk_path is not None:
                    unlink_episodes.append(src)

            scope_key = (bundle.user_id, bundle.folder_id)
            if bundle.meta_body is not None and scope_key in preexisting.scope_keys:
                state = await pipe.get_scope_state(bundle.user_id, bundle.folder_id)
                if state is None or not _meta_fields_consistent(bundle.meta_body, state):
                    hard_fail = True
                else:
                    if bundle.meta_document is not None:
                        meta_note = await docs.get_memory_note(
                            bundle.user_id, MEMORY_META_FILE, bundle.folder_id
                        )
                        if meta_note is not None:
                            meta_note.deleted_at = stamp
                            deleted += 1
                    if bundle.meta_disk_path is not None:
                        unlink_meta = True

            await session.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "memory.contract_episodes_scope_failed",
            user_id=bundle.user_id,
            folder_id=bundle.folder_id,
            error=str(e),
        )
        return 0, True

    for src in unlink_episodes:
        if src.disk_path is not None and src.disk_path.is_file():
            try:
                src.disk_path.unlink()
                deleted += 1
            except OSError as e:
                logger.warning(
                    "memory.contract_episodes_unlink_failed",
                    path=str(src.disk_path),
                    error=str(e),
                )
                return deleted, True
    if unlink_meta and bundle.meta_disk_path is not None and bundle.meta_disk_path.is_file():
        try:
            bundle.meta_disk_path.unlink()
            deleted += 1
        except OSError as e:
            logger.warning(
                "memory.contract_episodes_unlink_failed",
                path=str(bundle.meta_disk_path),
                error=str(e),
            )
            return deleted, True
    return deleted, hard_fail


async def migrate_document_episodes_to_tables(
    *,
    session_factory: Callable | None = None,
    base_dir: str | Path | None = None,
) -> EpisodeMigrationStats:
    """Copy legacy episodic + meta sources into dedicated tables (no deletes)."""
    if session_factory is None:
        from agentcore.db.base import async_session_factory

        session_factory = async_session_factory

    try:
        bundles = await collect_legacy_episode_scopes(
            session_factory=session_factory, base_dir=base_dir
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("memory.migrate_episodes_scan_failed", error=str(e))
        return EpisodeMigrationStats(0, 0, 0, 0, 0, 1)

    scopes = 0
    episodes_migrated = 0
    episodes_skipped = 0
    metas_migrated = 0
    failed = 0

    for bundle in bundles:
        if not bundle.episodes and bundle.meta_body is None:
            continue
        scopes += 1
        migrated, skipped, metas, ok = await _migrate_one_scope(bundle, session_factory)
        if not ok:
            failed += 1
            continue
        episodes_migrated += migrated
        episodes_skipped += skipped
        metas_migrated += metas

    stats = EpisodeMigrationStats(
        scopes_scanned=scopes,
        episodes_migrated=episodes_migrated,
        episodes_skipped=episodes_skipped,
        metas_migrated=metas_migrated,
        notes_soft_deleted=0,
        failed=failed,
    )
    if episodes_migrated or metas_migrated or failed:
        logger.info(
            "memory.migrate_episodes_done",
            scopes=scopes,
            episodes=episodes_migrated,
            metas=metas_migrated,
            skipped=episodes_skipped,
            failed=failed,
        )
    return stats


async def contract_document_episode_sources(
    *,
    session_factory: Callable | None = None,
    base_dir: str | Path | None = None,
    preexisting: LegacyTablePreimage | None = None,
) -> EpisodeMigrationStats:
    """Delete legacy sources that predated this run and still match the tables.

    Pass ``preexisting`` from :func:`snapshot_legacy_table_preimage` taken **before**
    migrate in the same deploy. When omitted (e.g. ``--contract-only``), a preimage is
    taken at contract start — rows already in the tables (previous deploy) are eligible.
    """
    if session_factory is None:
        from agentcore.db.base import async_session_factory

        session_factory = async_session_factory

    try:
        bundles = await collect_legacy_episode_scopes(
            session_factory=session_factory, base_dir=base_dir
        )
        if preexisting is None:
            preexisting = await snapshot_legacy_table_preimage(bundles, session_factory)
    except Exception as e:  # noqa: BLE001
        logger.warning("memory.contract_episodes_scan_failed", error=str(e))
        return EpisodeMigrationStats(0, 0, 0, 0, 0, 1)

    scopes = 0
    soft_deleted = 0
    contracted = 0
    failed = 0

    for bundle in bundles:
        if not bundle.episodes and bundle.meta_body is None:
            continue
        scopes += 1
        deleted, hard_fail = await _contract_one_scope(
            bundle, session_factory, preexisting
        )
        if hard_fail:
            failed += 1
        if deleted:
            soft_deleted += deleted
            contracted += 1

    stats = EpisodeMigrationStats(
        scopes_scanned=scopes,
        episodes_migrated=0,
        episodes_skipped=0,
        metas_migrated=0,
        notes_soft_deleted=soft_deleted,
        failed=failed,
        scopes_contracted=contracted,
    )
    if soft_deleted or failed or contracted:
        logger.info(
            "memory.contract_episodes_done",
            scopes=scopes,
            contracted=contracted,
            soft_deleted=soft_deleted,
            failed=failed,
            preexisting_episodes=len(preexisting.episode_ids),
            preexisting_scopes=len(preexisting.scope_keys),
        )
    return stats
