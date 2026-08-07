"""LocalWorkspace structured git — no Path.root, mock WorkspaceChannel ``git_run``."""

from __future__ import annotations

from typing import Any

import pytest

from agentcore.tools.builtin.git_ops import GitTool
from agentcore.tools.protocol import ToolContext
from agentcore.workspace.channel import WorkspaceOp
from agentcore.workspace.write_claims import WriteCoordinator

pytestmark = pytest.mark.anyio


class _FakeLocalBackend:
    """LocalWorkspace-shaped backend: location=local, no Path.root."""

    location = "local"
    root_label = "LocalProj"

    def __init__(self, *, has_git: bool) -> None:
        self._has_git = has_git

    async def exists(self, path: str) -> bool:
        return self._has_git and path.replace("\\", "/").rstrip("/") == ".git"


class _RecordingChannel:
    def __init__(self, replies: list[dict[str, Any]]) -> None:
        self._replies = list(replies)
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    async def request(
        self, op: Any, args: dict[str, Any], **kwargs: Any
    ) -> Any:
        self.calls.append((op, dict(args)))
        if not self._replies:
            raise AssertionError(f"unexpected git_run call: {op} {args}")
        return self._replies.pop(0)


def _channel_ctx(
    *,
    has_git: bool,
    replies: list[dict[str, Any]],
    agent_id: str = "ceo",
    as_worker: bool = False,
) -> tuple[ToolContext, _RecordingChannel]:
    channel = _RecordingChannel(replies)
    ctx = ToolContext(
        execution_id="e",
        run_id="s",
        agent_id=agent_id,
        backend=_FakeLocalBackend(has_git=has_git),
        user_id="u",
        workspace_channel=channel,
        write_coordinator=WriteCoordinator() if as_worker else None,
    )
    return ctx, channel


def _no_root_no_channel_ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="ceo",
        backend=_FakeLocalBackend(has_git=False),
        user_id="u",
        workspace_channel=None,
    )


async def test_no_root_no_channel_human_error_not_path_root_wording():
    result = await GitTool().execute({"subcommand": "status"}, _no_root_no_channel_ctx())
    assert result.success is False
    assert "桌面通道" in (result.error or "")
    assert "无本地根目录" not in (result.error or "")


async def test_channel_status_no_repo_soft_success():
    ctx, channel = _channel_ctx(has_git=False, replies=[])
    result = await GitTool().execute({"subcommand": "status"}, ctx)
    assert result.success is True
    assert result.metadata is not None
    assert result.metadata.get("code") == "no_repo"
    assert channel.calls == []


async def test_channel_write_no_repo_hard_error():
    ctx, channel = _channel_ctx(
        has_git=False, replies=[], agent_id="worker", as_worker=True
    )
    result = await GitTool().execute(
        {"subcommand": "add", "paths": ["a.txt"]},
        ctx,
    )
    assert result.success is False
    assert "没有 Git 仓库" in (result.error or "")
    assert channel.calls == []


async def test_channel_status_via_git_run():
    ctx, channel = _channel_ctx(
        has_git=True,
        replies=[
            {"stdout": "true\n", "stderr": "", "exit_code": 0},
            {
                "stdout": "## feature/x\n M a.txt\n",
                "stderr": "",
                "exit_code": 0,
            },
        ],
    )
    status = await GitTool().execute({"subcommand": "status"}, ctx)
    assert status.success is True
    assert "feature/x" in status.output
    assert len(channel.calls) == 2
    assert channel.calls[0][0] == WorkspaceOp.GIT_RUN
    assert channel.calls[0][1]["argv"] == ["rev-parse", "--is-inside-work-tree"]
    assert channel.calls[1][1]["argv"][0] == "status"


async def test_channel_log_via_git_run():
    ctx, channel = _channel_ctx(
        has_git=True,
        replies=[
            {"stdout": "true\n", "stderr": "", "exit_code": 0},
            {
                "stdout": "abc1234 message\n",
                "stderr": "",
                "exit_code": 0,
            },
        ],
    )
    log = await GitTool().execute({"subcommand": "log", "max_count": 5}, ctx)
    assert log.success is True
    assert "abc1234" in log.output
    assert channel.calls[1][0] == WorkspaceOp.GIT_RUN
    assert channel.calls[1][1]["argv"][0] == "log"
