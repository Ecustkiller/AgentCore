"""Integration test for the retention sweep (决策⑦), backed by real PostgreSQL.

Auto-skips when no PostgreSQL is reachable (via ``session_factory``). The sweep
uses ``async_session_factory`` directly (not the request-scoped ``get_db``), so it
is repointed at the test schema here; ``data_dir`` + storage are redirected to a
tmp dir so the purge only touches throwaway files.

Pins the ownership rules: an aged soft-deleted folder loses its shared space; an
aged ungrouped conversation loses its own space; an aged conversation that is
still grouped loses only its records (the folder's space lives on); and a
recently-deleted conversation is left untouched until its grace period ends.
"""

from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import select, update

from agentcore.config import settings
from agentcore.db.models import Conversation, Folder
from agentcore.db.repositories import (
    ConversationRepository,
    FolderRepository,
    UserRepository,
)
from agentcore.storage.factory import build_storage_provider
from agentcore.workspace import retention as retention_mod
from agentcore.workspace.locate import resolve_workspace_root, workspace_root_path
from agentcore.workspace.snapshots import create_snapshot


def _seed_space(uid: str, folder_id: str | None, conv_id: str) -> None:
    root = resolve_workspace_root(
        user_id=uid, folder_id=folder_id, conversation_id=conv_id
    )
    (root / "file.txt").write_text("data", encoding="utf-8")


async def test_retention_sweep_purges_aged_soft_deletes(
    session_factory, tmp_path: Path, monkeypatch
):
    # Route the sweep's own sessions to the test schema; storage → tmp filesystem.
    monkeypatch.setattr(retention_mod, "async_session_factory", session_factory)
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "storage_backend", "filesystem")
    monkeypatch.setattr(settings, "workspace_retention_days", 30)
    build_storage_provider.cache_clear()

    aged = datetime.now() - timedelta(days=40)

    async with session_factory() as s:
        uid = (await UserRepository(s).create(username="ret", display_name="ret")).user_id

    # Folder A: aged-deleted → space + record purged.
    # Folder B: alive, holds an aged-deleted grouped conv → conv records purged,
    #           B's shared space survives.
    async with session_factory() as s:
        folder_a = await FolderRepository(s).create(user_id=uid, name="A")
        folder_b = await FolderRepository(s).create(user_id=uid, name="B")
    fa, fb = folder_a.id, folder_b.id

    async with session_factory() as s:
        repo = ConversationRepository(s)
        grouped = await repo.create(user_id=uid, title="grouped")
        await repo.set_folder(grouped.id, fb, user_id=uid)  # lives in folder B
        ungrouped = await repo.create(user_id=uid, title="ungrouped")
        recent = await repo.create(user_id=uid, title="recent")
    gid, ugid, rid = grouped.id, ungrouped.id, recent.id

    # Seed files + a snapshot for each owned space.
    _seed_space(uid, fa, "seed")  # folder A shared space
    _seed_space(uid, fb, "seed")  # folder B shared space (must survive)
    _seed_space(uid, None, ugid)  # ungrouped conv's own space
    await create_snapshot(user_id=uid, folder_id=fa, conversation_id="seed")
    await create_snapshot(user_id=uid, folder_id=fb, conversation_id="seed")
    await create_snapshot(user_id=uid, folder_id=None, conversation_id=ugid)

    # Soft-delete A, the grouped conv, the ungrouped conv, and a recent conv.
    async with session_factory() as s:
        await FolderRepository(s).soft_delete(fa, user_id=uid)
        cr = ConversationRepository(s)
        await cr.soft_delete(gid, user_id=uid)
        await cr.soft_delete(ugid, user_id=uid)
        await cr.soft_delete(rid, user_id=uid)

    # Age everything except `recent` past the retention window.
    async with session_factory() as s:
        await s.execute(update(Folder).where(Folder.id == fa).values(deleted_at=aged))
        await s.execute(
            update(Conversation)
            .where(Conversation.id.in_([gid, ugid]))
            .values(deleted_at=aged)
        )
        await s.commit()

    result = await retention_mod.run_retention_sweep()

    assert result["folders"] == 1
    assert result["conversations"] == 2  # grouped + ungrouped (recent is too new)

    async with session_factory() as s:
        folders = (await s.execute(select(Folder.id))).scalars().all()
        convs = (await s.execute(select(Conversation.id))).scalars().all()

    assert fa not in folders  # aged folder hard-deleted
    assert fb in folders  # alive folder kept
    assert gid not in convs and ugid not in convs  # aged convs hard-deleted
    assert rid in convs  # recent soft-delete survives the sweep

    # Folder A's shared space is gone; folder B's survives; the ungrouped conv's
    # own space is gone.
    assert not workspace_root_path(
        user_id=uid, folder_id=fa, conversation_id="x"
    ).exists()
    assert workspace_root_path(
        user_id=uid, folder_id=fb, conversation_id="x"
    ).exists()
    assert not workspace_root_path(
        user_id=uid, folder_id=None, conversation_id=ugid
    ).exists()

    build_storage_provider.cache_clear()
