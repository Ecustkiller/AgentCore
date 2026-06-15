"""Tests for workspace path policy (conversation → directory).

Pins 决策③: a folder's conversations share one project space; ungrouped
conversations each get their own. ``data_dir`` is redirected to ``tmp_path`` so
nothing is created under the real ./data tree.
"""

from pathlib import Path

from agentcore.config import settings
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import (
    InteractionRegistry,
    default_interaction_registry,
)
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.locate import (
    LocalBinding,
    build_local_workspace,
    build_server_workspace,
    build_workspace,
    resolve_local_binding,
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


# --- cloud/local fork (双模式工作区 §七: 模式跟着文件在哪自动走) ----------------


def test_build_local_workspace_wires_channel_to_bound_root():
    """A binding yields a LocalWorkspace whose channel carries the desktop root_id."""
    sink = EventSink()
    registry = InteractionRegistry()
    ws = build_local_workspace(
        binding=LocalBinding(root_id="root-xyz", root_label="myproj"),
        sink=sink,
        conversation_id="c1",
        registry=registry,
        timeout_seconds=12.5,
    )
    assert isinstance(ws, LocalWorkspace)
    assert ws.location == "local"
    assert ws.root_label == "myproj"
    chan = ws._channel  # noqa: SLF001 - test-only wiring inspection
    assert chan.root_id == "root-xyz"
    assert chan.conversation_id == "c1"
    assert chan.sink is sink
    assert chan.registry is registry
    assert chan.timeout_seconds == 12.5


def test_build_local_workspace_defaults_to_shared_registry_and_timeout():
    """Omitted deps fall back to the process registry + configured op timeout.

    The shared registry is what the resolve endpoint settles, so a local turn must
    use it (not a private one) or the desktop's POSTed result would never land.
    """
    ws = build_local_workspace(
        binding=LocalBinding(root_id="r1"),
        sink=EventSink(),
        conversation_id="c1",
    )
    chan = ws._channel  # noqa: SLF001 - test-only wiring inspection
    assert chan.registry is default_interaction_registry()
    assert chan.timeout_seconds == settings.workspace_op_timeout_seconds
    assert ws.root_label == "workspace"  # binding's default label


def test_build_workspace_picks_local_when_bound():
    ws = build_workspace(
        user_id="u1",
        folder_id="f1",
        conversation_id="c1",
        sink=EventSink(),
        local_binding=LocalBinding(root_id="root-1"),
    )
    assert isinstance(ws, LocalWorkspace)
    assert ws.location == "local"


def test_build_workspace_falls_back_to_cloud_when_unbound(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    ws = build_workspace(
        user_id="u1",
        folder_id="f1",
        conversation_id="c1",
        sink=EventSink(),
        local_binding=None,
    )
    assert isinstance(ws, ServerWorkspace)
    assert ws.location == "server"


# --- resolve_local_binding: the §七 precedence rule (folder-first) -------------


def test_resolve_ungrouped_uses_own_binding():
    binding = resolve_local_binding(
        folder_id=None,
        folder_local_root_id=None,
        conversation_local_root_id="conv-root",
    )
    assert binding == LocalBinding(root_id="conv-root", root_label="workspace")


def test_resolve_ungrouped_unbound_is_cloud():
    assert (
        resolve_local_binding(
            folder_id=None,
            folder_local_root_id=None,
            conversation_local_root_id=None,
        )
        is None
    )


def test_resolve_foldered_uses_folder_binding_with_label():
    binding = resolve_local_binding(
        folder_id="f1",
        folder_local_root_id="folder-root",
        conversation_local_root_id="ignored-conv-root",
        label="MyProject",
    )
    assert binding == LocalBinding(root_id="folder-root", root_label="MyProject")


def test_resolve_foldered_ignores_conversation_binding():
    """A filed conversation uses the folder space only — its own (stale, set while
    ungrouped) root id must never resurrect once it is in an unbound folder."""
    assert (
        resolve_local_binding(
            folder_id="f1",
            folder_local_root_id=None,
            conversation_local_root_id="stale-conv-root",
        )
        is None
    )


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
