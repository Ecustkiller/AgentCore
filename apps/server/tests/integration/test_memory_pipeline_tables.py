"""DB-backed episodic pipeline: digestion survives re-open; backfill recovers polluted meta."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy.exc import ProgrammingError

from agentcore.db.repositories import DocumentRepository, MemoryPipelineRepository
from agentcore.memory.document_store import DocumentMemoryStore
from agentcore.memory.episode_store import DbEpisodeStore
from agentcore.memory.episodic import (
    append_episode,
    list_undigested_episodes,
    load_scope_meta,
    mark_episodes_digested,
    parse_legacy_scope_meta_json,
    purge_digested_episodes,
)
from agentcore.memory.migrate_episodes import (
    collect_legacy_episode_scopes,
    contract_document_episode_sources,
    migrate_document_episodes_to_tables,
    snapshot_legacy_table_preimage,
)
from agentcore.memory.store import EPISODIC_DIR, MEMORY_META_FILE


async def _migrate_then_lagged_contract(session_factory, *, base_dir=None):
    """Mirror deploy script: snapshot → migrate → contract with that preimage."""
    bundles = await collect_legacy_episode_scopes(
        session_factory=session_factory, base_dir=base_dir
    )
    preexisting = await snapshot_legacy_table_preimage(bundles, session_factory)
    migrate_stats = await migrate_document_episodes_to_tables(
        session_factory=session_factory, base_dir=base_dir
    )
    contract_stats = await contract_document_episode_sources(
        session_factory=session_factory,
        base_dir=base_dir,
        preexisting=preexisting,
    )
    return migrate_stats, contract_stats


@pytest.mark.asyncio
async def test_digestion_state_readable_across_sessions(session_factory):
    """Mark digested in one session; a fresh store must not re-list the episode.

    Catches the old bug where polluted ``_memory_meta.json`` made digestion never stick.
    """
    uid = str(uuid4())
    async with session_factory() as session:
        store = DbEpisodeStore(session)
        ep = await append_episode(
            store,
            user_id=uid,
            conversation_id=str(uuid4()),
            summary="本场讨论了部署。",
            max_chars=200,
        )
        await mark_episodes_digested(store, uid, [ep.id])

    async with session_factory() as session:
        store = DbEpisodeStore(session)
        assert await list_undigested_episodes(store, uid) == []
        meta = await load_scope_meta(store, uid)
        assert meta.last_semantic_at is not None


@pytest.mark.asyncio
async def test_purge_digested_episodes_after_30_days(session_factory):
    uid = str(uuid4())
    async with session_factory() as session:
        store = DbEpisodeStore(session)
        old = await append_episode(
            store, user_id=uid, conversation_id=str(uuid4()), summary="old", max_chars=50
        )
        recent = await append_episode(
            store,
            user_id=uid,
            conversation_id=str(uuid4()),
            summary="recent",
            max_chars=50,
        )
        await mark_episodes_digested(
            store, uid, [old.id], consolidated_at=datetime.now(UTC) - timedelta(days=31)
        )
        await mark_episodes_digested(
            store,
            uid,
            [recent.id],
            consolidated_at=datetime.now(UTC) - timedelta(days=1),
        )
        deleted = await purge_digested_episodes(store, older_than_days=30, user_id=uid)
        assert deleted == 1
        repo = MemoryPipelineRepository(session)
        assert await repo.get_episode(old.id) is None
        assert await repo.get_episode(recent.id) is not None


@pytest.mark.asyncio
async def test_backfill_recovers_frontmatter_polluted_sidecar(session_factory):
    """``ensure_apply_key`` wrapped meta JSON in YAML FM — backfill must still recover ids."""
    uid = str(uuid4())
    folder = None
    episode_id = uuid4().hex
    polluted = (
        "---\napply: always\n---\n"
        '{"digested_ids": ["'
        + episode_id
        + '"], "last_semantic_at": "2026-01-15T12:00:00+00:00",'
        ' "explore_workspace_key": "ws:abc", "explore_fingerprint": "fp1",'
        ' "explore_fingerprint_dirty": true}\n'
    )
    meta = parse_legacy_scope_meta_json(polluted)
    assert meta.explore_workspace_key == "ws:abc"
    assert meta.explore_fingerprint == "fp1"
    assert meta.explore_fingerprint_dirty is True
    assert meta.last_semantic_at is not None

    async with session_factory() as session:
        docs = DocumentRepository(session)
        body = (
            f"<!-- conversation_id: {uuid4()} -->\n"
            f"<!-- created_at: 2026-01-10T00:00:00+00:00 -->\n\n"
            "旧摘要\n"
        )
        await docs.save_memory_note(
            uid,
            f"{EPISODIC_DIR}/{episode_id}.md",
            body,
            folder,
            role="general",
            apply_mode="always",
        )
        await docs.save_memory_note(
            uid,
            MEMORY_META_FILE,
            polluted,
            folder,
            role="general",
            apply_mode="always",
        )

    stats, contract = await _migrate_then_lagged_contract(session_factory)
    assert stats.episodes_migrated == 1
    assert stats.metas_migrated == 1
    assert stats.notes_soft_deleted == 0
    # Same deploy: self-lag keeps sources (row did not predate this run).
    assert contract.scopes_contracted == 0
    assert contract.notes_soft_deleted == 0

    async with session_factory() as session:
        store = DbEpisodeStore(session)
        assert await list_undigested_episodes(store, uid) == []
        meta = await load_scope_meta(store, uid)
        assert meta.explore_workspace_key == "ws:abc"
        assert meta.explore_fingerprint == "fp1"
        assert meta.explore_fingerprint_dirty is True
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, MEMORY_META_FILE) != ""
        assert await mem.load(uid, f"{EPISODIC_DIR}/{episode_id}.md") != ""

    # Next deploy: rows now predate contract → sources cleared.
    contract2 = await contract_document_episode_sources(session_factory=session_factory)
    assert contract2.scopes_contracted == 1
    assert contract2.notes_soft_deleted >= 2

    async with session_factory() as session:
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, MEMORY_META_FILE) == ""
        assert await mem.load(uid, f"{EPISODIC_DIR}/{episode_id}.md") == ""


@pytest.mark.asyncio
async def test_contract_skips_same_run_migrated_scope(session_factory):
    """Sources migrated in this run must not be deleted until a later deploy."""
    uid = str(uuid4())
    episode_id = uuid4().hex
    async with session_factory() as session:
        docs = DocumentRepository(session)
        body = (
            f"<!-- conversation_id: {uuid4()} -->\n"
            f"<!-- created_at: 2026-01-10T00:00:00+00:00 -->\n\n"
            "同轮摘要\n"
        )
        await docs.save_memory_note(
            uid,
            f"{EPISODIC_DIR}/{episode_id}.md",
            body,
            None,
            role="general",
            apply_mode="always",
        )
        await docs.save_memory_note(
            uid,
            MEMORY_META_FILE,
            '{"explore_workspace_key": "ws:same"}',
            None,
            role="general",
            apply_mode="always",
        )

    _migrate, contract = await _migrate_then_lagged_contract(session_factory)
    assert _migrate.episodes_migrated == 1
    assert contract.scopes_contracted == 0

    async with session_factory() as session:
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, f"{EPISODIC_DIR}/{episode_id}.md") != ""
        assert await mem.load(uid, MEMORY_META_FILE) != ""


@pytest.mark.asyncio
async def test_contract_deletes_previous_run_migrated_scope(session_factory):
    """Sources whose table rows already existed before this run are eligible to delete."""
    uid = str(uuid4())
    episode_id = uuid4().hex
    async with session_factory() as session:
        docs = DocumentRepository(session)
        body = (
            f"<!-- conversation_id: {uuid4()} -->\n"
            f"<!-- created_at: 2026-01-10T00:00:00+00:00 -->\n\n"
            "上轮摘要\n"
        )
        await docs.save_memory_note(
            uid,
            f"{EPISODIC_DIR}/{episode_id}.md",
            body,
            None,
            role="general",
            apply_mode="always",
        )
        await docs.save_memory_note(
            uid,
            MEMORY_META_FILE,
            '{"explore_workspace_key": "ws:prev"}',
            None,
            role="general",
            apply_mode="always",
        )

    # Deploy N: migrate only (lagged contract no-ops).
    migrate_stats, contract_n = await _migrate_then_lagged_contract(session_factory)
    assert migrate_stats.episodes_migrated == 1
    assert contract_n.scopes_contracted == 0

    # Deploy N+1: contract sees preexisting rows → deletes sources.
    contract_n1 = await contract_document_episode_sources(session_factory=session_factory)
    assert contract_n1.scopes_contracted == 1
    assert contract_n1.notes_soft_deleted >= 2

    async with session_factory() as session:
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, f"{EPISODIC_DIR}/{episode_id}.md") == ""
        assert await mem.load(uid, MEMORY_META_FILE) == ""
        store = DbEpisodeStore(session)
        undigested = await list_undigested_episodes(store, uid)
        assert len(undigested) == 1
        assert "上轮摘要" in undigested[0].summary


@pytest.mark.asyncio
async def test_backfill_merges_empty_scope_state_fields(session_factory):
    """Existing scope_state keeps prior values; empty fields fill from legacy meta."""
    uid = str(uuid4())
    prior = datetime(2025, 6, 1, tzinfo=UTC)
    async with session_factory() as session:
        pipe = MemoryPipelineRepository(session)
        await pipe.upsert_scope_state(
            uid,
            None,
            last_semantic_at=prior,
            explore_workspace_key=None,
            explore_fingerprint=None,
            explore_fingerprint_dirty=False,
        )
        docs = DocumentRepository(session)
        meta_body = (
            '{"last_semantic_at": "2026-01-15T12:00:00+00:00",'
            ' "explore_workspace_key": "ws:new", "explore_fingerprint": "fp-new",'
            ' "explore_fingerprint_dirty": true}'
        )
        await docs.save_memory_note(
            uid, MEMORY_META_FILE, meta_body, None, role="general", apply_mode="always"
        )

    stats = await migrate_document_episodes_to_tables(session_factory=session_factory)
    assert stats.metas_migrated == 1
    assert stats.failed == 0

    async with session_factory() as session:
        store = DbEpisodeStore(session)
        meta = await load_scope_meta(store, uid)
        assert meta.last_semantic_at == prior
        assert meta.explore_workspace_key == "ws:new"
        assert meta.explore_fingerprint == "fp-new"
        assert meta.explore_fingerprint_dirty is True
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, MEMORY_META_FILE) != ""


@pytest.mark.asyncio
async def test_backfill_partial_parse_failure_does_not_delete_or_half_write(
    session_factory, tmp_path: Path
):
    """One unparseable episode → scope not migrated; no deletes; no sibling inserts."""
    uid = str(uuid4())
    good_id = uuid4().hex
    bad_id = uuid4().hex
    async with session_factory() as session:
        docs = DocumentRepository(session)
        good_body = (
            f"<!-- conversation_id: {uuid4()} -->\n"
            f"<!-- created_at: 2026-01-10T00:00:00+00:00 -->\n\n"
            "好摘要\n"
        )
        await docs.save_memory_note(
            uid,
            f"{EPISODIC_DIR}/{good_id}.md",
            good_body,
            None,
            role="general",
            apply_mode="always",
        )

    # Disk-only unparseable sibling (comment-only → empty summary). Avoid
    # ``save_memory_note`` so YAML apply frontmatter cannot become a fake summary.
    episodic = tmp_path / uid / EPISODIC_DIR
    episodic.mkdir(parents=True)
    (episodic / f"{bad_id}.md").write_text(
        f"<!-- conversation_id: {uuid4()} -->\n\n",
        encoding="utf-8",
    )

    stats = await migrate_document_episodes_to_tables(
        session_factory=session_factory, base_dir=tmp_path
    )
    assert stats.failed == 1
    assert stats.episodes_migrated == 0
    assert stats.notes_soft_deleted == 0

    async with session_factory() as session:
        pipe = MemoryPipelineRepository(session)
        assert await pipe.get_episode(good_id) is None
        assert await pipe.get_episode(bad_id) is None
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, f"{EPISODIC_DIR}/{good_id}.md") != ""

    contract = await contract_document_episode_sources(
        session_factory=session_factory, base_dir=tmp_path
    )
    assert contract.scopes_contracted == 0
    async with session_factory() as session:
        mem = DocumentMemoryStore(session)
        assert await mem.load(uid, f"{EPISODIC_DIR}/{good_id}.md") != ""
    assert (episodic / f"{bad_id}.md").is_file()


@pytest.mark.asyncio
async def test_backfill_reads_disk_episodic_when_absent_from_documents(
    session_factory, tmp_path: Path
):
    """migrate_episodes is the single reader — leftover disk 情景/ must be copied."""
    uid = str(uuid4())
    episode_id = uuid4().hex
    scope_dir = tmp_path / uid
    episodic = scope_dir / EPISODIC_DIR
    episodic.mkdir(parents=True)
    (episodic / f"{episode_id}.md").write_text(
        f"<!-- conversation_id: {uuid4()} -->\n"
        f"<!-- created_at: 2026-02-01T00:00:00+00:00 -->\n\n"
        "盘上摘要\n",
        encoding="utf-8",
    )
    (scope_dir / MEMORY_META_FILE).write_text(
        '{"explore_workspace_key": "ws:disk", "explore_fingerprint": "fp-disk"}',
        encoding="utf-8",
    )

    stats, contract = await _migrate_then_lagged_contract(
        session_factory, base_dir=tmp_path
    )
    assert stats.episodes_migrated == 1
    assert stats.metas_migrated == 1
    assert contract.scopes_contracted == 0

    async with session_factory() as session:
        store = DbEpisodeStore(session)
        undigested = await list_undigested_episodes(store, uid)
        assert len(undigested) == 1
        assert undigested[0].summary == "盘上摘要"
        meta = await load_scope_meta(store, uid)
        assert meta.explore_workspace_key == "ws:disk"

    # Same deploy keeps disk sources; next deploy clears them.
    assert (episodic / f"{episode_id}.md").is_file()
    contract2 = await contract_document_episode_sources(
        session_factory=session_factory, base_dir=tmp_path
    )
    assert contract2.scopes_contracted == 1
    assert not (episodic / f"{episode_id}.md").exists()
    assert not (scope_dir / MEMORY_META_FILE).exists()


@pytest.mark.asyncio
async def test_list_undigested_and_load_scope_meta_propagate_db_errors():
    """Missing-table / programming errors must not collapse to empty results."""
    from contextlib import asynccontextmanager

    uid = str(uuid4())

    class _BoomRepo:
        async def list_undigested(self, *_a, **_k):
            raise ProgrammingError(
                "SELECT 1",
                {},
                Exception('relation "memory_episodes" does not exist'),
            )

        async def get_scope_state(self, *_a, **_k):
            raise ProgrammingError(
                "SELECT 1",
                {},
                Exception('relation "memory_scope_states" does not exist'),
            )

    class _BoomStore(DbEpisodeStore):
        @asynccontextmanager
        async def _repo(self):  # type: ignore[override]
            yield _BoomRepo()

    store = _BoomStore()
    with pytest.raises(ProgrammingError):
        await list_undigested_episodes(store, uid)
    with pytest.raises(ProgrammingError):
        await load_scope_meta(store, uid)
