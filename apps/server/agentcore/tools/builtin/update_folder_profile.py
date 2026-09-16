"""update_folder_profile — retired writer; the live CEO table never wires it.

Execute does not write ``画像.md`` / ``导航.md`` / ``主题/``. ``remember`` stays
user-rules-only. File-page edits still go through documents / memory PUT.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from agentcore.core.types import ToolApproval, ToolFace
from agentcore.memory.store import MemoryStore
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

UPDATE_FOLDER_PROFILE_TOOL_NAME = "update_folder_profile"


@dataclass
class UpdateFolderProfileTool:
    """CEO-only: previously merge-wrote folder 画像; now a no-write close-out."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.MEMORY,
        catalog_summary="文件夹画像（已停写）",
    )

    folder_id: str | None = None
    store: MemoryStore | None = None
    # Kept so callers that precompute workspace identity still construct cleanly.
    workspace_key: str | None = None
    prompt_holders: list[Any] = field(default_factory=list)

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=UPDATE_FOLDER_PROFILE_TOOL_NAME,
            description=(
                "已停写：系统不再写入文件夹画像、导航或主题。已有文件保留。"
                "了解这张桌请直接读工作区文件。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": (
                            "文件夹画像（Markdown：## 小节 + - 要点）。"
                            "只写这桌几乎每个任务都会用到的事实；有证据才写。没写的小节保留。"
                        ),
                    },
                    "navigation": {
                        "type": "string",
                        "description": (
                            "可选。短入口「导航.md」全文（一句话定位 + 任务路由表）。"
                            "省略则不改已有导航。"
                        ),
                    },
                    "topics": {
                        "type": "array",
                        "description": (
                            "可选，默认省略。"
                            "仅当可独立复用的子系统/域≥2 且全塞进画像会臃肿时拆出。"
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "slug": {
                                    "type": "string",
                                    "description": "短英文/拼音 id（主题/<slug>.md）。",
                                },
                                "content": {
                                    "type": "string",
                                    "description": "该主题 Markdown 全文（可复用域事实）。",
                                },
                            },
                            "required": ["slug", "content"],
                        },
                    },
                },
                "required": ["content"],
            },
            face=ToolFace.FOLDER,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        del arguments
        if not self.folder_id:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="当前是裸聊（没有文件夹），不能写文件夹画像。",
                error="no_folder",
            )
        # Leftover explore-pending must not strand same-turn delivery writes.
        context.cold_start_explore_pending = False
        context.write_scope = "project"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=(
                "系统不再写入文件夹画像、导航或主题。已有文件保留。"
                "了解这张桌请直接读工作区文件。"
            ),
            display={
                "written": False,
                "kind": "folder_profile",
                "topics": [],
                "navigation": None,
            },
        )


def build_update_folder_profile_tool(
    *,
    folder_id: str | None = None,
    store: MemoryStore | None = None,
    prompt_holders: list[Any] | None = None,
    workspace_key: str | None = None,
) -> UpdateFolderProfileTool:
    return UpdateFolderProfileTool(
        folder_id=folder_id,
        store=store,
        prompt_holders=list(prompt_holders or ()),
        workspace_key=workspace_key,
    )
