"""Builtin surface roster (``ToolSurface.BUILTIN``).

Append platform / capability-face tools here. Order is part of the public
surface; keep relative order when inserting.
"""

from __future__ import annotations


def load_roster() -> tuple[type, ...]:
    from agentcore.config import settings
    from agentcore.tools.builtin.browser import BrowserTool
    from agentcore.tools.builtin.code_intel import CodeIntelTool
    from agentcore.tools.builtin.file_ops import (
        ApplyPatchTool,
        FileBatchTool,
        FileDeleteTool,
        FileListTool,
        FileReadTool,
        FileWriteTool,
        GlobTool,
        StrReplaceTool,
    )
    from agentcore.tools.builtin.grep import GrepTool
    from agentcore.tools.builtin.host import HostTool
    from agentcore.tools.builtin.md_export import MdExportTool
    from agentcore.tools.builtin.project_diagnostics import ProjectDiagnosticsTool
    from agentcore.tools.builtin.run import RunTool
    from agentcore.tools.builtin.web.search import WebSearchTool
    from agentcore.tools.builtin.web.web_fetch import WebFetchTool

    roster: tuple[type, ...] = (
        # platform base
        WebSearchTool,
        WebFetchTool,
        FileReadTool,
        FileWriteTool,
        StrReplaceTool,
        ApplyPatchTool,
        FileListTool,
        GlobTool,
        FileDeleteTool,
        FileBatchTool,
        MdExportTool,
        GrepTool,
        CodeIntelTool,
        ProjectDiagnosticsTool,
        RunTool,
        # L3 团队浏览器：单一 ``browser``（GRANTABLE · action 政策表；CEO+worker）
        BrowserTool,
        # Host：用户这台电脑上的短命令（schema NEVER · 运行时按 host 轴升审批）
        HostTool,
    )
    if not settings.knowledge_search_enabled:
        return roster
    # opt-in：在 roster 层条件加载，而不是在 build_*_registry 里事后过滤。
    # 这样 registry / 能力目录 / ALWAYS wiring 读到的声明集完全一致，不会出现
    # 「目录里列了工具但注册表里没有」的漂移。
    from agentcore.tools.builtin.knowledge_search import KnowledgeSearchTool

    return (*roster, KnowledgeSearchTool)
