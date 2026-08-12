"""Account cloud path for episodes / scope-state matches local DbEpisodeStore behavior."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest

from agentcore.account.credentials import (
    AccountCredentials,
    account_credentials_scope,
    cloud_memory_episode_append,
    cloud_memory_episodes_list_undigested,
    cloud_memory_episodes_mark_digested,
    cloud_memory_scope_state_get,
    cloud_memory_scope_state_save,
)
from agentcore.memory.episode_store import DbEpisodeStore, ScopeMemoryMeta
from agentcore.memory.episodic import (
    append_episode,
    list_undigested_episodes,
    load_scope_meta,
    mark_episodes_digested,
    save_scope_meta,
)


@pytest.mark.asyncio
async def test_account_episode_and_scope_state_round_trip(session_factory, monkeypatch):
    """Sidecar cloud helpers ↔ account handlers ↔ DB: same digestion / explore fields."""
    uid = str(uuid4())
    folder = str(uuid4())
    conv = str(uuid4())

    async with session_factory() as session:
        local = DbEpisodeStore(session)
        ep = await append_episode(
            local,
            user_id=uid,
            conversation_id=conv,
            summary="账号路径摘要",
            scope=folder,
            max_chars=200,
        )
        await save_scope_meta(
            local,
            uid,
            ScopeMemoryMeta(
                last_semantic_at=None,
                explore_workspace_key="ws:test",
                explore_fingerprint="fp-local",
                explore_fingerprint_dirty=False,
            ),
            scope=folder,
        )
        await mark_episodes_digested(local, uid, [ep.id], scope=folder)
        assert await list_undigested_episodes(local, uid, scope=folder) == []
        meta = await load_scope_meta(local, uid, scope=folder)
        assert meta.explore_workspace_key == "ws:test"
        assert meta.last_semantic_at is not None

    uid2 = str(uuid4())
    calls: list[str] = []

    async def _fake_post(creds, *, path, payload, op):  # noqa: ANN001
        del creds, op
        calls.append(path)
        async with session_factory() as session:
            store = DbEpisodeStore(session)
            if path == "/memory/episodes/append":
                rec = await store.append_episode(
                    uid2,
                    conversation_id=payload["conversation_id"],
                    summary=payload["summary"],
                    scope=payload.get("scope"),
                    actions_json=payload.get("actions_json") or "",
                )
                return {
                    "id": rec.id,
                    "conversation_id": rec.conversation_id,
                    "summary": rec.summary,
                    "created_at": rec.created_at,
                    "actions_json": rec.actions_json,
                }
            if path == "/memory/episodes/list-undigested":
                rows = await store.list_undigested(uid2, scope=payload.get("scope"))
                return {
                    "episodes": [
                        {
                            "id": r.id,
                            "conversation_id": r.conversation_id,
                            "summary": r.summary,
                            "created_at": r.created_at,
                            "actions_json": r.actions_json,
                        }
                        for r in rows
                    ]
                }
            if path == "/memory/episodes/mark-digested":
                stamp = None
                raw = payload.get("consolidated_at")
                if raw:
                    stamp = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                await store.mark_digested(
                    uid2,
                    list(payload.get("episode_ids") or []),
                    scope=payload.get("scope"),
                    consolidated_at=stamp,
                )
                return {"ok": True}
            if path == "/memory/scope-state/get":
                m = await store.load_scope_meta(uid2, scope=payload.get("scope"))
                return {
                    "last_semantic_at": (
                        m.last_semantic_at.isoformat() if m.last_semantic_at else None
                    ),
                    "explore_workspace_key": m.explore_workspace_key,
                    "explore_fingerprint": m.explore_fingerprint,
                    "explore_fingerprint_dirty": m.explore_fingerprint_dirty,
                }
            if path == "/memory/scope-state/save":
                last = None
                raw = payload.get("last_semantic_at")
                if raw:
                    last = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                await store.save_scope_meta(
                    uid2,
                    ScopeMemoryMeta(
                        last_semantic_at=last,
                        explore_workspace_key=payload.get("explore_workspace_key"),
                        explore_fingerprint=payload.get("explore_fingerprint"),
                        explore_fingerprint_dirty=bool(
                            payload.get("explore_fingerprint_dirty")
                        ),
                    ),
                    scope=payload.get("scope"),
                )
                return {"ok": True}
            raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr("agentcore.account.credentials._post_json", _fake_post)
    creds = AccountCredentials(api_key="test", base_url="http://account.test/v1/account")

    data = await cloud_memory_episode_append(
        creds,
        scope=folder,
        conversation_id=conv,
        summary="云侧摘要",
    )
    assert data["id"]
    episodes = await cloud_memory_episodes_list_undigested(creds, scope=folder)
    assert len(episodes) == 1
    await cloud_memory_scope_state_save(
        creds,
        scope=folder,
        explore_workspace_key="ws:cloud",
        explore_fingerprint="fp-cloud",
        explore_fingerprint_dirty=True,
    )
    state = await cloud_memory_scope_state_get(creds, scope=folder)
    assert state["explore_workspace_key"] == "ws:cloud"
    assert state["explore_fingerprint_dirty"] is True
    await cloud_memory_episodes_mark_digested(
        creds,
        scope=folder,
        episode_ids=[data["id"]],
        consolidated_at=datetime.now(UTC).isoformat(),
    )
    assert await cloud_memory_episodes_list_undigested(creds, scope=folder) == []
    assert "/memory/episodes/append" in calls
    assert "/memory/scope-state/save" in calls

    with account_credentials_scope(creds):
        cloud_store = DbEpisodeStore()
        assert await cloud_store.list_undigested(uid2, scope=folder) == []
        meta = await cloud_store.load_scope_meta(uid2, scope=folder)
        assert meta.explore_workspace_key == "ws:cloud"
