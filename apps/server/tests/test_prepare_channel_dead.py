"""Prepare-budget abort is a coded AgentCoreError; leftover WIO is not rescued."""

from __future__ import annotations

from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import LOCAL_CHANNEL_DEAD, LocalChannelDeadError
from agentcore.runtime.error_fields import error_fields_for
from agentcore.workspace.limits import CHANNEL_DEAD_PREPARE_ABORT
from agentcore.workspace.protocol import WorkspaceIOError


def test_error_fields_for_typed_channel_dead_prepare_abort():
    code, message, _ctx = error_fields_for(
        LocalChannelDeadError(),
        fallback_code=ErrorCode.STREAM_ERROR,
        fallback_message="服务出错了，请稍后重试。",
    )
    assert code == ErrorCode.LOCAL_CHANNEL_DEAD
    assert message == LOCAL_CHANNEL_DEAD
    assert "服务出错了" not in message


def test_error_fields_for_does_not_map_workspace_io_channel_dead_copy():
    code, message, _ctx = error_fields_for(
        WorkspaceIOError(CHANNEL_DEAD_PREPARE_ABORT),
        fallback_code=ErrorCode.STREAM_ERROR,
        fallback_message="服务出错了，请稍后重试。",
    )
    assert code == ErrorCode.STREAM_ERROR
    assert message == "服务出错了，请稍后重试。"
