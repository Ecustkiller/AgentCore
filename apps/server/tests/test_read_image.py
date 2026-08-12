"""Tests for CEO ``read_image`` (workspace file → VisionReader deep-read)."""

from __future__ import annotations

import base64
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.costing import ROLE_VISION, RunCost
from agentcore.tools.builtin.read_image import ReadImageTool
from agentcore.tools.protocol import ToolContext
from agentcore.vision.protocol import VisionReading
from agentcore.workspace.protocol import PathNotFound

pytestmark = pytest.mark.anyio

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


class _FakeReader:
    def __init__(
        self,
        text: str = "图中有一个红色按钮",
        *,
        usage: TokenUsage | None = None,
        model: str = "qwen-vl-max",
        credential_source: str | None = "user",
    ) -> None:
        self.text = text
        self.usage = usage if usage is not None else TokenUsage(input_tokens=900, output_tokens=30)
        self.model = model
        self.credential_source = credential_source
        self.calls: list[tuple[str, str]] = []

    async def read(self, png_base64: str, prompt: str) -> VisionReading:
        self.calls.append((png_base64, prompt))
        return VisionReading(text=self.text, usage=self.usage, model=self.model)


def _ctx(
    *,
    reader: object | None = None,
    backend: Any | None = None,
    cost_sink: list[RunCost] | None = None,
) -> ToolContext:
    if backend is None:
        backend = MagicMock()
        backend.read_bytes = AsyncMock(return_value=PNG_BYTES)
    return ToolContext.create(
        execution_id="exec-1",
        run_id="run-1",
        agent_id="agent-1",
        backend=backend,
        user_id="user-1",
        conversation_id="conv-1",
        vision_reader=reader,  # type: ignore[arg-type]
        cost_sink=cost_sink,
    )


async def test_read_image_success_and_bills_with_credential_source():
    reader = _FakeReader(credential_source="user")
    sink: list[RunCost] = []
    result = await ReadImageTool().execute(
        {"path": "shots/ui.png", "prompt": "图里有几个按钮？"},
        _ctx(reader=reader, cost_sink=sink),
    )
    assert result.success
    assert result.output == reader.text
    assert reader.calls and reader.calls[0][1] == "图里有几个按钮？"
    assert base64.b64decode(reader.calls[0][0]) == PNG_BYTES
    assert len(sink) == 1
    row = sink[0]
    assert row.role == ROLE_VISION
    assert row.model == "qwen-vl-max"
    assert row.parent_run_id == "run-1"
    assert row.cost.get("credential_source") == "user"
    assert row.tokens["input"] == 900
    assert row.tokens["output"] == 30
    # BYOK slot → user pricing (estimated ledger).
    assert row.cost_estimated_nano > 0
    assert row.cost_total_nano == 0


async def test_read_image_no_vision_reader_errors():
    result = await ReadImageTool().execute(
        {"path": "shots/ui.png", "prompt": "描述一下"},
        _ctx(reader=None),
    )
    assert not result.success
    assert "未配置" in (result.error or "")


async def test_read_image_path_missing_errors():
    backend = MagicMock()
    backend.read_bytes = AsyncMock(side_effect=PathNotFound("shots/missing.png"))
    result = await ReadImageTool().execute(
        {"path": "shots/missing.png", "prompt": "描述一下"},
        _ctx(reader=_FakeReader(), backend=backend),
    )
    assert not result.success
    assert "无法读取" in (result.error or "")


async def test_read_image_rejects_non_image_extension():
    result = await ReadImageTool().execute(
        {"path": "notes/readme.md", "prompt": "读一下"},
        _ctx(reader=_FakeReader()),
    )
    assert not result.success
    assert "不是可识读的图片" in (result.error or "")


async def test_read_image_rejects_empty_prompt():
    result = await ReadImageTool().execute(
        {"path": "shots/ui.png", "prompt": "  "},
        _ctx(reader=_FakeReader()),
    )
    assert not result.success
    assert "prompt" in (result.error or "")
