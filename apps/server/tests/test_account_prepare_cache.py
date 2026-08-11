"""Account prepare rules/memory snapshot cache (cache_only + warm seed)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from agentcore.account.credentials import (
    AccountCredentials,
    account_credentials_scope,
)
from agentcore.memory.account_prepare_cache import (
    AccountPrepareSnapshot,
    clear_account_rules_memory_cache,
    get_account_rules_memory_snapshot,
    prepare_account_folder_id,
    prepare_reads_cache_only,
    seed_account_rules_memory_cache,
    warm_account_rules_memory,
)
from agentcore.memory.document_store import DocumentMemoryStore
from agentcore.memory.injection import MemoryTopic, load_memory_topics
from agentcore.memory.rules_injection import assemble_turn_rules, load_on_demand_user_rules
from agentcore.sidecar.protocol import INVALID_REQUEST, NOT_INITIALIZED
from agentcore.sidecar.server import SidecarServer

pytestmark = pytest.mark.anyio


@pytest.fixture
def account_creds() -> AccountCredentials:
    return AccountCredentials(
        api_key="account-jwt",
        base_url="https://example.test/v1/account",
    )


class _EmptyMemoryStore:
    async def list(self, *_a, **_k):
        return []

    async def load(self, *_a, **_k):
        return ""


async def test_ticketed_miss_skips_cloud(monkeypatch: pytest.MonkeyPatch, account_creds):
    clear_account_rules_memory_cache()
    calls: list[str] = []

    async def _rules(*_a, **_k):
        calls.append("rules")
        raise AssertionError("unexpected cloud call: rules")

    async def _mem_list(*_a, **_k):
        calls.append("mem_list")
        raise AssertionError("unexpected cloud call: mem_list")

    async def _mem_load(*_a, **_k):
        calls.append("mem_load")
        raise AssertionError("unexpected cloud call: mem_load")

    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_list_user_rules", _rules
    )
    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_memory_list", _mem_list
    )
    monkeypatch.setattr(
        "agentcore.account.credentials.cloud_memory_load", _mem_load
    )

    with account_credentials_scope(account_creds):
        user_md, mem_md = await assemble_turn_rules(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id="F1",
            enabled=True,
            max_docs=20,
            max_chars=20000,
        )
        topics = await load_memory_topics(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id="F1",
            enabled=True,
        )
        on_demand = await load_on_demand_user_rules("u1", folder_id="F1")

    assert user_md == ""
    assert mem_md == ""
    assert topics == []
    assert on_demand == []
    assert calls == []


async def test_seed_then_hit(account_creds):
    clear_account_rules_memory_cache()
    seed_account_rules_memory_cache(
        "u1",
        "F1",
        AccountPrepareSnapshot(
            rules_payload={
                "global_rules": [{"name": "用户规则.md", "content": "- 全局规则"}],
                "project_rules": [
                    {"name": "项目规则.md", "content": "- 项目规则"},
                ],
                "global_on_demand_rules": [
                    {"name": "合规.md", "content": "- 合规摘要行\n更多"},
                ],
                "project_on_demand_rules": [],
            },
            memory_bodies={
                ("", "偏好.md"): "- 沟通偏好\n",
                ("", "画像.md"): "- 全局画像\n",
                ("F1", "画像.md"): "- 项目画像\n",
                ("F1", "导航.md"): "- 项目导航\n",
            },
            memory_topics=(MemoryTopic(name="api", summary="API 约定"),),
        ),
    )

    with account_credentials_scope(account_creds):
        user_md, mem_md = await assemble_turn_rules(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id="F1",
            enabled=True,
            max_docs=20,
            max_chars=20000,
        )
        topics = await load_memory_topics(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id="F1",
            enabled=True,
        )
        on_demand = await load_on_demand_user_rules("u1", folder_id="F1")

    assert "全局规则" in user_md
    assert "项目规则" in user_md
    assert "沟通偏好" in mem_md
    assert "项目画像" in mem_md
    assert "项目导航" in mem_md
    assert topics == [MemoryTopic(name="api", summary="API 约定")]
    assert len(on_demand) == 1
    assert on_demand[0].name == "合规"


async def test_folder_none_key_distinct_from_project(account_creds):
    clear_account_rules_memory_cache()
    seed_account_rules_memory_cache(
        "u1",
        None,
        AccountPrepareSnapshot(
            rules_payload={
                "global_rules": [{"name": "用户规则.md", "content": "- bare"}],
            }
        ),
    )
    seed_account_rules_memory_cache(
        "u1",
        "F1",
        AccountPrepareSnapshot(
            rules_payload={
                "global_rules": [{"name": "用户规则.md", "content": "- project"}],
            }
        ),
    )
    bare = get_account_rules_memory_snapshot("u1", None)
    proj = get_account_rules_memory_snapshot("u1", "F1")
    assert bare is not None and "bare" in str(bare.rules_payload)
    assert proj is not None and "project" in str(proj.rules_payload)


async def test_warm_rules_list_once_and_seeds(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    clear_account_rules_memory_cache()
    rules_calls = {"n": 0}

    async def _rules(creds, *, folder_id):
        rules_calls["n"] += 1
        assert folder_id == "F1"
        return {
            "global_rules": [{"name": "用户规则.md", "content": "- r"}],
            "project_rules": [],
            "global_on_demand_rules": [
                {"name": "附录.md", "content": "- od\n"},
            ],
            "project_on_demand_rules": [],
        }

    async def _mem_list(creds, *, scope):
        if scope is None:
            return [
                {"path": "偏好.md", "version": "1"},
                {"path": "主题/foo.md", "version": "1"},
            ]
        return [{"path": "画像.md", "version": "1"}]

    async def _mem_load(creds, *, path, scope):
        return f"# {path}\n- body for {scope}\n"

    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.cloud_list_user_rules", _rules
    )
    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.cloud_memory_list", _mem_list
    )
    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.cloud_memory_load", _mem_load
    )

    snap = await warm_account_rules_memory(
        account_creds, user_id="u1", folder_id="F1"
    )
    assert rules_calls["n"] == 1
    assert snap.degraded is False
    assert get_account_rules_memory_snapshot("u1", "F1") is snap or (
        get_account_rules_memory_snapshot("u1", "F1") is not None
    )

    with account_credentials_scope(account_creds):
        user_md, mem_md = await assemble_turn_rules(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id="F1",
            enabled=True,
            max_docs=20,
            max_chars=20000,
        )
        topics = await load_memory_topics(
            _EmptyMemoryStore(),  # type: ignore[arg-type]
            "u1",
            folder_id="F1",
            enabled=True,
        )
        on_demand = await load_on_demand_user_rules("u1", folder_id="F1")

    assert " - r" in user_md or "r" in user_md
    assert "偏好" in mem_md or "body" in mem_md
    assert any(t.name == "foo" for t in topics)
    assert len(on_demand) == 1
    assert rules_calls["n"] == 1  # prepare did not re-hit cloud


def _recorder() -> tuple[list[dict[str, Any]], Any]:
    sent: list[dict[str, Any]] = []

    async def write_line(line: str) -> None:
        sent.append(json.loads(line))

    return sent, write_line


def test_warm_account_rules_memory_requires_initialize(tmp_path: Path) -> None:
    clear_account_rules_memory_cache()
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "warmAccountRulesMemory",
                    "params": {
                        "folderId": None,
                        "accountAuth": {
                            "baseUrl": "https://example.test/v1/account",
                            "apiKey": "k",
                        },
                    },
                }
            )
        )

    asyncio.run(run())
    err = next(m for m in sent if m.get("id") == 2 and "error" in m)
    assert err["error"]["code"] == NOT_INITIALIZED


def test_warm_account_rules_memory_requires_account(tmp_path: Path) -> None:
    clear_account_rules_memory_cache()
    (tmp_path / "x.py").write_text("x = 1\n", encoding="utf-8")
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "local",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                    },
                }
            )
        )
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "warmAccountRulesMemory",
                    "params": {"folderId": "F1"},
                }
            )
        )

    asyncio.run(run())
    err = next(m for m in sent if m.get("id") == 2 and "error" in m)
    assert err["error"]["code"] == INVALID_REQUEST


def test_warm_account_rules_memory_seeds_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clear_account_rules_memory_cache()
    (tmp_path / "x.py").write_text("x = 1\n", encoding="utf-8")
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def _warm(creds, *, user_id, folder_id):
        snap = AccountPrepareSnapshot(
            rules_payload={
                "global_rules": [{"name": "用户规则.md", "content": "- warm"}],
            },
            memory_topics=(MemoryTopic(name="t", summary="s"),),
        )
        seed_account_rules_memory_cache(user_id, folder_id, snap)
        return snap

    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.warm_account_rules_memory",
        _warm,
    )

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "user-1",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                    },
                }
            )
        )
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "warmAccountRulesMemory",
                    "params": {
                        "folderId": "F1",
                        "accountAuth": {
                            "baseUrl": "https://example.test/v1/account",
                            "apiKey": "k",
                        },
                    },
                }
            )
        )

    asyncio.run(run())
    init = next(m for m in sent if m.get("id") == 1)
    assert init["result"]["capabilities"]["warmAccountRulesMemory"] is True
    ok = next(m for m in sent if m.get("id") == 2)
    assert ok["result"]["ok"] is True
    assert ok["result"]["topicCount"] == 1
    hit = get_account_rules_memory_snapshot("user-1", "F1")
    assert hit is not None
    assert "warm" in str(hit.rules_payload)


async def test_warm_includes_memory_meta_even_when_unlistable(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    """``_memory_meta.json`` is not a ``*.md`` list entry — warm must still load it."""
    clear_account_rules_memory_cache()
    loaded: list[tuple[str | None, str]] = []

    async def _rules(*_a, **_k):
        return {
            "global_rules": [],
            "project_rules": [],
            "global_on_demand_rules": [],
            "project_on_demand_rules": [],
        }

    async def _mem_list(creds, *, scope):
        if scope is None:
            return [{"path": "偏好.md", "version": "1"}]
        # Project list has 画像 but omits meta (json sidecar).
        return [{"path": "画像.md", "version": "1"}, {"path": "导航.md", "version": "1"}]

    async def _mem_load(creds, *, path, scope):
        loaded.append((scope, path))
        if path == "_memory_meta.json":
            return '{"explore_workspace_key": "ws:1"}\n'
        return f"# {path}\n"

    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.cloud_list_user_rules", _rules
    )
    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.cloud_memory_list", _mem_list
    )
    monkeypatch.setattr(
        "agentcore.memory.account_prepare_cache.cloud_memory_load", _mem_load
    )

    snap = await warm_account_rules_memory(
        account_creds, user_id="u1", folder_id="F1"
    )
    assert ("F1", "_memory_meta.json") in loaded
    assert (None, "_memory_meta.json") in loaded
    assert snap.memory_bodies[("F1", "_memory_meta.json")].startswith("{")
    assert snap.memory_bodies[("F1", "画像.md")].startswith("#")


async def test_document_store_cache_only_miss_skips_cloud(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    clear_account_rules_memory_cache()
    calls: list[str] = []

    async def _boom(*_a, **_k):
        calls.append("cloud")
        raise AssertionError("cloud must not be called under prepare_reads_cache_only")

    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_load", _boom)
    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_list", _boom)
    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_save", _boom)

    store = DocumentMemoryStore()
    token = prepare_reads_cache_only.set(True)
    folder_token = prepare_account_folder_id.set("F1")
    try:
        with account_credentials_scope(account_creds):
            assert await store.load("u1", "画像.md", scope="F1") == ""
            assert await store.list("u1", scope="F1") == []
            await store.save("u1", "_memory_meta.json", "{}\n", scope="F1")
    finally:
        prepare_reads_cache_only.reset(token)
        prepare_account_folder_id.reset(folder_token)
    assert calls == []


async def test_document_store_cache_only_seed_serves_explore_profile(
    monkeypatch: pytest.MonkeyPatch, account_creds
):
    from agentcore.memory.explore_profile import (
        load_project_profile,
        project_profile_explore_reason,
    )
    from agentcore.memory.store import CORE_MEMORY_FILE, MEMORY_META_FILE

    clear_account_rules_memory_cache()
    seed_account_rules_memory_cache(
        "u1",
        "F1",
        AccountPrepareSnapshot(
            memory_bodies={
                ("F1", CORE_MEMORY_FILE): "## 技术栈与工具\n- Go\n",
                (
                    "F1",
                    MEMORY_META_FILE,
                ): '{"explore_workspace_key": "ws:abc", "digested_ids": []}\n',
            },
        ),
    )

    async def _boom(*_a, **_k):
        raise AssertionError("must not call cloud on cache hit")

    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_load", _boom)
    monkeypatch.setattr("agentcore.account.credentials.cloud_memory_save", _boom)

    store = DocumentMemoryStore()
    token = prepare_reads_cache_only.set(True)
    folder_token = prepare_account_folder_id.set("F1")
    try:
        with account_credentials_scope(account_creds):
            profile = await load_project_profile(store, "u1", "F1")
            assert "Go" in profile
            reason = await project_profile_explore_reason(
                store, "u1", "F1", current_workspace_key="ws:abc"
            )
            assert reason is None  # non-empty + matching key → no explore
    finally:
        prepare_reads_cache_only.reset(token)
        prepare_account_folder_id.reset(folder_token)
