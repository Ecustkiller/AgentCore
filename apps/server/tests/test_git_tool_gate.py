"""Git is not a model tool. ``run`` / ``host`` carry the commands.

``git_execution_enabled_for`` still answers whether this workspace can exec git,
which the ``<工作区>`` fact line uses. The factory table and the 缺口 do not
name a ``git`` tool.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.runtime.context.workspace_context import build_workspace_context
from agentcore.tools.builtin import (
    build_builtin_registry,
    build_ceo_tool_registry,
    build_worker_registry,
    git_execution_enabled_for,
)
from agentcore.tools.builtin.git_ops.binary_health import (
    reset_git_binary_health_for_tests,
    set_git_binary_health_for_tests,
)
from agentcore.tools.catalog import build_capability_catalog
from agentcore.tools.registration import declared_tool_name, declared_tools


def _gaps(ctx: str) -> set[str]:
    for line in ctx.splitlines():
        if line.startswith("缺口："):
            return {p.strip() for p in line.removeprefix("缺口：").split("、") if p.strip()}
    return set()


@pytest.fixture(autouse=True)
def _unprobed_git_binary():
    """Default every case to "never probed" — the binary axis is tested explicitly."""
    reset_git_binary_health_for_tests()
    yield
    reset_git_binary_health_for_tests()


class _ChannelLocalBackend:
    """LocalWorkspace shape: location=local, no ``root`` (desktop channel only)."""

    location = "local"
    root_label = "MyProject"

    def __init__(self) -> None:
        self._channel = object()


def _rooted_backend(tmp_path: Path, *, location: str) -> object:
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.server import ServerWorkspace

    root = tmp_path / location
    root.mkdir(exist_ok=True)
    return ServerWorkspace(root=root, sandbox=SubprocessSandbox(), location=location)


def test_git_is_not_a_model_tool():
    names = {declared_tool_name(cls) for cls in declared_tools()}
    assert "git" not in names
    assert "git" not in build_builtin_registry().names
    assert "git" not in build_worker_registry().names
    assert "git" not in build_ceo_tool_registry().names
    assert "git" not in {entry.schema.name for entry in build_capability_catalog()}


def test_predicate_cloud_and_sidecar_always_enabled(tmp_path):
    cloud = _rooted_backend(tmp_path, location="server")
    sidecar = _rooted_backend(tmp_path, location="local")
    for backend in (cloud, sidecar):
        assert git_execution_enabled_for(backend, desktop_online=True) is True
        # A rooted workspace spawns git in-process — the client channel is irrelevant.
        assert git_execution_enabled_for(backend, desktop_online=False) is True


def test_predicate_channel_local_follows_desktop_online():
    backend = _ChannelLocalBackend()
    assert git_execution_enabled_for(backend, desktop_online=True) is True
    assert git_execution_enabled_for(backend, desktop_online=False) is False


def test_predicate_no_backend_keeps_tool_listed():
    """Capability catalog / bare tests build without a backend — keep git advertised."""
    assert git_execution_enabled_for(None) is True


def test_capability_line_git_unassembled_when_desktop_offline():
    out = build_workspace_context(_ChannelLocalBackend(), desktop_online=False)
    assert "git" not in _gaps(out)
    assert "Git：" not in out
    assert "装配启用" not in out
    assert "在桌面客户端打开【本对话】" not in out
    assert "文件读写与其它已装配工具不受影响" not in out
    # 声称纪律在基座对照结构面，事实层不复述开工姿势
    assert "同轮可开工" not in out
    from agentcore.runtime.resolve.prompt import _CEO_CORE_HINT, _DEFAULT_SYSTEM_PROMPT

    assert "git…）" not in _DEFAULT_SYSTEM_PROMPT  # 不按能力枚举
    assert "未装配能力" not in _CEO_CORE_HINT
    # An unassembled turn must not advise a tool the model does not hold.
    assert "init_baseline" not in out


def test_capability_line_git_assembled_when_desktop_online():
    out = build_workspace_context(_ChannelLocalBackend(), desktop_online=True)
    assert "git" not in _gaps(out)
    assert "未装配 git" not in out


def test_capability_line_git_assembled_for_cloud_and_sidecar(tmp_path):
    for location in ("server", "local"):
        out = build_workspace_context(
            _rooted_backend(tmp_path, location=location), desktop_online=False
        )
        assert "git" not in _gaps(out), location


def test_gaps_never_name_a_git_tool(tmp_path):
    cases = [
        (_ChannelLocalBackend(), False),
        (_ChannelLocalBackend(), True),
        (_rooted_backend(tmp_path, location="server"), False),
        (_rooted_backend(tmp_path, location="local"), False),
    ]
    for backend, desktop_online in cases:
        assert "git" not in build_worker_registry(
            backend=backend, desktop_online=desktop_online
        ).names
        out = build_workspace_context(backend, desktop_online=desktop_online)
        assert "git" not in _gaps(out), (backend.location, desktop_online)


# ---- binary axis: the in-process transport also needs a real ``git`` on PATH ----


def test_missing_binary_withholds_git_from_rooted_workspaces(tmp_path):
    """An image without ``git`` must withhold the tool, not hand out FileNotFoundError."""
    set_git_binary_health_for_tests(False, failure=("not_found", "no git"))
    for location in ("server", "local"):
        backend = _rooted_backend(tmp_path, location=location)
        assert git_execution_enabled_for(backend, desktop_online=True) is False, location
        names = build_worker_registry(backend=backend, desktop_online=True).names
        assert "git" not in names, location
        # Withholding git must not disturb the rest of the roster.
        assert "read" in names, location


def test_missing_binary_never_touches_the_channel_transport():
    """Channel-backed local runs git on the USER's machine — the server probe is moot.

    Gating this branch on the API process's own PATH would strip git from every
    desktop user the moment the server image lost the binary.
    """
    set_git_binary_health_for_tests(False, failure=("not_found", "no git"))
    backend = _ChannelLocalBackend()
    assert git_execution_enabled_for(backend, desktop_online=True) is True
    assert "git" not in build_worker_registry(backend=backend, desktop_online=True).names
    assert "git" not in _gaps(build_workspace_context(backend, desktop_online=True))


def test_missing_binary_keeps_catalog_listing():
    """能力图鉴 is environment-free — a dead binary must not erase the entry."""
    set_git_binary_health_for_tests(False, failure=("not_found", "no git"))
    assert git_execution_enabled_for(None) is True
    assert "git" not in {entry.schema.name for entry in build_capability_catalog()}


def test_healthy_binary_keeps_rooted_workspaces_assembled(tmp_path):
    set_git_binary_health_for_tests(True)
    backend = _rooted_backend(tmp_path, location="server")
    assert git_execution_enabled_for(backend, desktop_online=False) is True
    assert "git" not in build_worker_registry(backend=backend, desktop_online=False).names


def test_capability_line_matches_registry_when_binary_missing(tmp_path):
    """Same predicate on both sides, on the binary axis too."""
    set_git_binary_health_for_tests(False, failure=("not_found", "no git"))
    backend = _rooted_backend(tmp_path, location="server")
    assembled = "git" in build_worker_registry(backend=backend, desktop_online=False).names
    out = build_workspace_context(backend, desktop_online=False)
    assert assembled is False
    assert "git" not in _gaps(out)
