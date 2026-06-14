"""Tests for workspace path policy (conversation → directory).

Pins 决策③: a folder's conversations share one project space; ungrouped
conversations each get their own. ``data_dir`` is redirected to ``tmp_path`` so
nothing is created under the real ./data tree.
"""

from pathlib import Path

from agentcore.config import settings
from agentcore.workspace.locate import (
    build_server_workspace,
    resolve_workspace_root,
    workspace_storage_key,
)
from agentcore.workspace.server import ServerWorkspace


def test_folder_conversation_uses_folder_space(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    root = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    assert root == tmp_path / "workspaces" / "u1" / "f1"
    assert root.is_dir()


def test_conversations_in_same_folder_share_one_root(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    r1 = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    r2 = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c2")
    assert r1 == r2


def test_ungrouped_conversations_get_independent_roots(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    r1 = resolve_workspace_root(user_id="u1", folder_id=None, conversation_id="c1")
    r2 = resolve_workspace_root(user_id="u1", folder_id=None, conversation_id="c2")
    assert r1 != r2
    assert r1 == tmp_path / "workspaces" / "u1" / "conv" / "c1"
    assert r1.parent.name == "conv"


def test_users_are_isolated_by_directory(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    a = resolve_workspace_root(user_id="alice", folder_id="f1", conversation_id="c1")
    b = resolve_workspace_root(user_id="bob", folder_id="f1", conversation_id="c1")
    assert a != b
    assert a.parent.name == "alice"  # <workspaces>/<user_id>/<folder_id>


def test_build_server_workspace_targets_resolved_root(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    ws = build_server_workspace(user_id="u1", folder_id=None, conversation_id="c9")
    assert isinstance(ws, ServerWorkspace)
    assert ws.location == "server"


# --- storage key (mirrors the on-disk layout for snapshots) ---


def test_storage_key_folder_space():
    key = workspace_storage_key(user_id="u1", folder_id="f1", conversation_id="c1")
    assert key == "workspaces/u1/f1"


def test_storage_key_ungrouped_space():
    key = workspace_storage_key(user_id="u1", folder_id=None, conversation_id="c1")
    assert key == "workspaces/u1/conv/c1"


def test_storage_key_mirrors_on_disk_root(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    root = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    key = workspace_storage_key(user_id="u1", folder_id="f1", conversation_id="c1")
    # The key is exactly the workspace path relative to data_dir.
    assert root == Path(settings.data_dir) / key
