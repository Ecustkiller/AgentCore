"""Unit tests for Host tools and DesktopClientChannel host ops."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from agentcore.core.types import (
    CommandAxis,
    FileWriteAxis,
    HostAxis,
    PermissionAxes,
    TeamKickoffAxis,
    ToolApproval,
)
from agentcore.desktop.channel import DesktopClientChannel, HostOp, HostOpError
from agentcore.tools.builtin import (
    build_ceo_tool_registry,
    build_worker_registry,
    delegation_grantable_tool_names,
)
from agentcore.tools.builtin.host import (
    HostAudioSetDefaultTool,
    HostInfoTool,
    HostNetworkSummaryTool,
    HostOpenSettingsTool,
    HostOsLogSummaryTool,
    HostPackageInstallTool,
    HostPingTool,
    HostServiceRestartTool,
    HostShellTool,
    HostStorageTool,
    clamp_package_timeout,
    clamp_shell_timeout,
    normalize_os_log_args,
    shell_cmd_env_blocks,
    shell_fuse_blocks,
    shell_silent_install_blocks,
    validate_package_install_args,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registration import execution_class_tool_names, host_class_tool_names


@pytest.mark.asyncio
async def test_host_ping_requires_channel():
    tool = HostPingTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=None,
    )
    result = await tool.execute({}, ctx)
    assert not result.success
    assert "桌面" in (result.error or "")


@pytest.mark.asyncio
async def test_host_info_via_channel():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={"platform": "win32", "hostname": "DESKTOP-1"}
    )
    tool = HostInfoTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({}, ctx)
    assert result.success
    assert "<untrusted_content>" in result.output
    assert "DESKTOP-1" in result.output
    channel.request_host.assert_awaited_once_with(HostOp.INFO, {})


@pytest.mark.asyncio
async def test_host_open_settings_rejects_unknown_panel():
    tool = HostOpenSettingsTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({"panel": "bluetooth"}, ctx)
    assert not result.success
    assert "sound" in (result.error or "")
    assert "display" in (result.error or "")


@pytest.mark.asyncio
async def test_host_open_settings_accepts_display():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={"opened": True, "panel": "display", "uri": "ms-settings:display"}
    )
    tool = HostOpenSettingsTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({"panel": "display"}, ctx)
    assert result.success
    channel.request_host.assert_awaited_once_with(
        HostOp.OPEN_SETTINGS, {"panel": "display"}
    )


@pytest.mark.asyncio
async def test_host_audio_set_default_requires_device():
    tool = HostAudioSetDefaultTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({}, ctx)
    assert not result.success
    assert "device_id" in (result.error or "")


@pytest.mark.asyncio
async def test_host_audio_set_default_forwards():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={"set": True, "device_id": "{0.0.0.00000000}.{abc}", "name": "Speakers"}
    )
    tool = HostAudioSetDefaultTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({"device_name": "Speakers"}, ctx)
    assert result.success
    channel.request_host.assert_awaited_once_with(
        HostOp.AUDIO_SET_DEFAULT, {"device_name": "Speakers"}
    )


@pytest.mark.asyncio
async def test_host_service_restart_rejects_unknown():
    tool = HostServiceRestartTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({"service": "Spooler"}, ctx)
    assert not result.success
    assert "Audiosrv" in (result.error or "")
    assert "Spooler" in (result.error or "")


@pytest.mark.asyncio
async def test_host_service_restart_accepts_audiosrv():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={"restarted": True, "service": "Audiosrv", "status": "Running"}
    )
    tool = HostServiceRestartTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({"service": "audiosrv"}, ctx)
    assert result.success
    channel.request_host.assert_awaited_once_with(
        HostOp.SERVICE_RESTART, {"service": "Audiosrv"}
    )


@pytest.mark.asyncio
async def test_host_storage_via_channel():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={"platform": "win32", "volumes": [{"device_id": "C:"}]}
    )
    tool = HostStorageTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({}, ctx)
    assert result.success
    assert "C:" in result.output
    channel.request_host.assert_awaited_once_with(HostOp.STORAGE, {})


@pytest.mark.asyncio
async def test_host_network_summary_via_channel():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={
            "platform": "win32",
            "adapters": [{"name": "Ethernet", "addresses": []}],
            "note": "local_iface_summary_no_port_scan",
        }
    )
    tool = HostNetworkSummaryTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({}, ctx)
    assert result.success
    assert "no_port_scan" in result.output
    channel.request_host.assert_awaited_once_with(HostOp.NETWORK_SUMMARY, {})


@pytest.mark.asyncio
async def test_host_os_log_summary_via_channel():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={
            "platform": "win32",
            "bounded": True,
            "entries": [{"time": "t", "level": "Error", "source": "App", "message": "x"}],
            "note": "os_event_log_bounded_summary",
        }
    )
    tool = HostOsLogSummaryTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute(
        {"source": "App", "level": "error", "minutes": 30, "max_entries": 5},
        ctx,
    )
    assert result.success
    assert "bounded" in result.output
    channel.request_host.assert_awaited_once_with(
        HostOp.OS_LOG_SUMMARY,
        {
            "source": "App",
            "level": "error",
            "minutes": 30,
            "max_entries": 5,
            "max_bytes": 24_000,
        },
    )


def test_normalize_os_log_args_clamps():
    out = normalize_os_log_args(
        {"minutes": 99999, "max_entries": 999, "max_bytes": 9_999_999, "level": "nope"}
    )
    assert out["minutes"] == 1440
    assert out["max_entries"] == 80
    assert out["max_bytes"] == 48_000
    assert out["level"] == "warning"


@pytest.mark.asyncio
async def test_host_shell_rejects_empty_command():
    tool = HostShellTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({"command": "  "}, ctx)
    assert not result.success
    assert "非空" in (result.error or "")


@pytest.mark.asyncio
async def test_host_shell_rejects_cmd_style_env():
    tool = HostShellTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute(
        {"command": "if (Test-Path '%APPDATA%\\Cursor\\logs') { 'ok' }"},
        ctx,
    )
    assert not result.success
    assert "%VAR%" in (result.error or "") or "$env:" in (result.error or "")
    ctx.desktop_channel.request_host.assert_not_called()


@pytest.mark.asyncio
async def test_host_shell_fuse_blocks_rm_rf_root():
    tool = HostShellTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({"command": "rm -rf /"}, ctx)
    assert not result.success
    assert "熔断" in (result.error or "")
    ctx.desktop_channel.request_host.assert_not_called()


@pytest.mark.asyncio
async def test_host_shell_rejects_long_running_dev_server():
    tool = HostShellTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({"command": "npm run dev"}, ctx)
    assert not result.success
    assert "长驻" in (result.error or "")
    assert "terminal" in (result.error or "")
    ctx.desktop_channel.request_host.assert_not_called()


def test_shell_fuse_and_timeout_helpers():
    assert shell_fuse_blocks("shutdown /s /t 0")
    assert shell_fuse_blocks("Format-Volume -DriveLetter C")
    assert shell_fuse_blocks("echo hi") is None
    assert shell_cmd_env_blocks("Get-ChildItem $env:APPDATA") is None
    assert shell_cmd_env_blocks("dir %APPDATA%\\Cursor\\logs")
    assert shell_cmd_env_blocks("echo %LOCALAPPDATA%")
    assert clamp_shell_timeout(None) == 60
    assert clamp_shell_timeout(999) == 120
    assert clamp_shell_timeout(0) == 1
    assert clamp_shell_timeout("45") == 45


@pytest.mark.asyncio
async def test_host_shell_forwards_with_timeout():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={
            "timed_out": False,
            "exit_code": 0,
            "stdout": "ok",
            "stderr": "",
            "cwd": "C:\\Users\\u",
        }
    )
    tool = HostShellTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute({"command": "echo ok", "timeout_seconds": 15}, ctx)
    assert result.success
    assert "echo" not in result.output or "ok" in result.output
    channel.request_host.assert_awaited_once()
    call = channel.request_host.await_args
    assert call.args[0] is HostOp.SHELL
    assert call.args[1]["command"] == "echo ok"
    assert call.args[1]["timeout_seconds"] == 15
    assert call.kwargs["timeout"] == 30.0  # 15 + 15 slack


@pytest.mark.asyncio
async def test_channel_request_host_emits_and_returns():
    registry = MagicMock()

    async def _suspend(*_a, **kwargs):
        on_suspended = kwargs.get("on_suspended")
        if callable(on_suspended):
            on_suspended()
        return {"ok": True, "value": {"ok": True, "platform": "win32"}}

    registry.suspend = AsyncMock(side_effect=_suspend)
    sink = MagicMock()
    channel = DesktopClientChannel(
        sink=sink,
        conversation_id="c1",
        registry=registry,
        timeout_seconds=1.0,
    )
    value = await channel.request_host(HostOp.PING)
    assert value["ok"] is True
    sink.emit.assert_called_once()
    event = sink.emit.call_args[0][0]
    assert event.type.value == "host_op_required"
    assert event.payload["op"] == "host_ping"


@pytest.mark.asyncio
async def test_channel_maps_host_failure():
    registry = MagicMock()
    registry.suspend = AsyncMock(
        return_value={"ok": False, "error": {"detail": "desktop gone"}}
    )
    sink = MagicMock()
    channel = DesktopClientChannel(
        sink=sink,
        conversation_id="c1",
        registry=registry,
        timeout_seconds=1.0,
    )
    with pytest.raises(HostOpError, match="desktop gone"):
        await channel.request_host(HostOp.AUDIO_DEVICES)


def test_host_tools_gated_on_desktop_online_and_host_axis():
    names_off = {s.name for s in build_worker_registry(desktop_online=False).list_all()}
    assert "host_ping" not in names_off
    assert "host_open_settings" not in names_off

    axes_off = PermissionAxes(
        host=HostAxis.OFF,
    )
    names_axis_off = {
        s.name
        for s in build_worker_registry(
            desktop_online=True, permission_axes=axes_off
        ).list_all()
    }
    assert "host_ping" not in names_axis_off

    names_on = {
        s.name for s in build_worker_registry(desktop_online=True).list_all()
    }
    assert {
        "host_ping",
        "host_info",
        "host_audio_devices",
        "host_storage",
        "host_power",
        "host_network_summary",
        "host_apps",
        "host_os_log_summary",
        "host_shell",
        "host_open_settings",
        "host_audio_set_default",
        "host_service_restart",
        "host_package_install",
    } <= names_on

    ceo = {
        s.name
        for s in build_ceo_tool_registry(desktop_online=True).list_all()
    }
    assert {
        "host_ping",
        "host_info",
        "host_audio_devices",
        "host_storage",
        "host_power",
        "host_network_summary",
        "host_apps",
        "host_os_log_summary",
        "host_shell",
    } <= ceo
    assert "host_open_settings" not in ceo
    assert "host_audio_set_default" not in ceo
    assert "host_service_restart" not in ceo
    assert "host_package_install" not in ceo
    # P3: CEO may hold host_shell (GRANTABLE exception).
    assert (
        build_ceo_tool_registry(desktop_online=True).get("host_shell").schema.approval
        is ToolApproval.GRANTABLE
    )


def test_host_not_in_execution_or_kickoff_whitelist():
    host_names = host_class_tool_names()
    assert host_names
    assert host_names.isdisjoint(execution_class_tool_names())
    assert host_names.isdisjoint(delegation_grantable_tool_names())
    assert "host_audio_set_default" in host_names
    assert "host_service_restart" in host_names
    assert "host_package_install" in host_names
    assert "host_shell" in host_names


def test_host_l2_is_audit_grantable():
    """L2/L3/host_shell GRANTABLE must land on agent_audit_events like other grantable tools."""
    from agentcore.runtime.audit.projector import _grantable_tool_names

    names = _grantable_tool_names()
    assert "host_open_settings" in names
    assert "host_audio_set_default" in names
    assert "host_service_restart" in names
    assert "host_package_install" in names
    assert "host_shell" in names
    # L1 NEVER tools stay off the grantable ledger.
    assert "host_info" not in names
    assert "host_storage" not in names


@pytest.mark.asyncio
async def test_host_package_install_rejects_non_allowlisted_manager():
    tool = HostPackageInstallTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute({"manager": "choco", "package_id": "git"}, ctx)
    assert not result.success
    assert "winget" in (result.error or "")
    ctx.desktop_channel.request_host.assert_not_called()


@pytest.mark.asyncio
async def test_host_package_install_forwards_winget():
    channel = MagicMock()
    channel.request_host = AsyncMock(
        return_value={
            "timed_out": False,
            "exit_code": 0,
            "manager": "winget",
            "package_id": "Microsoft.VisualStudioCode",
        }
    )
    tool = HostPackageInstallTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="w1",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=channel,
    )
    result = await tool.execute(
        {
            "manager": "winget",
            "package_id": "Microsoft.VisualStudioCode",
            "timeout_seconds": 120,
        },
        ctx,
    )
    assert result.success
    channel.request_host.assert_awaited_once()
    call = channel.request_host.await_args
    assert call.args[0] is HostOp.PACKAGE_INSTALL
    assert call.args[1]["manager"] == "winget"
    assert call.args[1]["package_id"] == "Microsoft.VisualStudioCode"
    assert call.args[1]["timeout_seconds"] == 120
    assert call.kwargs["timeout"] == 150.0  # 120 + 30 slack


@pytest.mark.asyncio
async def test_host_shell_silent_install_fuse():
    tool = HostShellTool()
    ctx = ToolContext.create(
        execution_id="e1",
        run_id="r1",
        agent_id="ceo",
        backend=MagicMock(location="local"),
        user_id="u1",
        desktop_channel=MagicMock(),
    )
    result = await tool.execute(
        {"command": r"msiexec /i Setup.msi /quiet"}, ctx
    )
    assert not result.success
    assert "静默安装" in (result.error or "") or "启发式" in (result.error or "")
    assert "host_package_install" in (result.error or "")
    ctx.desktop_channel.request_host.assert_not_called()


def test_shell_silent_install_and_package_helpers():
    samples = [
        r"msiexec /i foo.msi /qn",
        r".\Setup.exe /S",
        r"Start-Process Setup.exe -ArgumentList '/quiet'",
        r"Installer.exe /VERYSILENT",
        r"curl -L https://example.com/Setup.exe -o Setup.exe",
    ]
    for cmd in samples:
        assert shell_silent_install_blocks(cmd), cmd
    assert shell_silent_install_blocks("echo hi") is None
    assert shell_fuse_blocks("echo hi") is None
    assert validate_package_install_args(manager="choco", package_id="git")
    assert validate_package_install_args(
        manager="winget", package_id="Microsoft.VisualStudioCode"
    ) is None
    assert validate_package_install_args(
        manager="brew", package_id="docker", cask=True
    ) is None
    assert validate_package_install_args(
        manager="apt", package_id="docker.io", cask=True
    )
    assert clamp_package_timeout(None) == 600
    assert clamp_package_timeout(30) == 60
    assert clamp_package_timeout(9999) == 900


def test_host_package_install_absent_without_desktop_online():
    names_off = {s.name for s in build_worker_registry(desktop_online=False).list_all()}
    assert "host_package_install" not in names_off
    assert "host_shell" not in names_off


def test_command_ask_keeps_host_l1():
    """command=ask withholds execution_class but must not strip Host L1 / host_shell."""
    axes = PermissionAxes(
        file_write=FileWriteAxis.ASK,
        command=CommandAxis.ASK,
        team_kickoff=TeamKickoffAxis.RULES,
        host=HostAxis.ASK,
    )
    names = {
        s.name
        for s in build_worker_registry(
            desktop_online=True, permission_axes=axes
        ).list_all()
    }
    assert "host_ping" in names
    assert "host_info" in names
    assert "host_shell" in names
    assert "host_package_install" in names
    assert "code_execute" not in names

    ceo = {
        s.name
        for s in build_ceo_tool_registry(
            desktop_online=True, permission_axes=axes
        ).list_all()
    }
    assert "host_shell" in ceo
    assert "host_package_install" not in ceo
