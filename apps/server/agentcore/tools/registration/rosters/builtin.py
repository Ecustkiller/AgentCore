"""Builtin surface roster (``ToolSurface.BUILTIN``).

Append platform / capability-face tools here. Order is part of the public
surface; keep relative order when inserting.
"""

from __future__ import annotations


def load_roster() -> tuple[type, ...]:
    from agentcore.tools.builtin.archive import ArchiveTool
    from agentcore.tools.builtin.browser import BrowserTool
    from agentcore.tools.builtin.docs_read import DocsReadTool
    from agentcore.tools.builtin.docs_write import DocsWriteTool
    from agentcore.tools.builtin.file_ops import (
        FileBatchTool,
        FileDeleteTool,
        FileListTool,
        FileReadTool,
        FileWriteTool,
        GlobTool,
        MkdirTool,
        StrReplaceTool,
    )
    from agentcore.tools.builtin.git_ops import GitTool
    from agentcore.tools.builtin.grep import GrepTool
    from agentcore.tools.builtin.host import HostTool
    from agentcore.tools.builtin.md_export import MdExportTool
    from agentcore.tools.builtin.run import RunTool
    from agentcore.tools.builtin.web.download_url import DownloadUrlTool
    from agentcore.tools.builtin.web.search import WebSearchTool
    from agentcore.tools.builtin.web.web_fetch import WebFetchTool

    return (
        # platform base
        WebSearchTool,
        WebFetchTool,
        FileReadTool,
        FileWriteTool,
        StrReplaceTool,
        FileListTool,
        GlobTool,
        FileDeleteTool,
        MkdirTool,
        FileBatchTool,
        MdExportTool,
        ArchiveTool,
        DownloadUrlTool,
        GrepTool,
        DocsReadTool,
        DocsWriteTool,
        GitTool,
        RunTool,
        # L3 团队浏览器：单一 ``browser``（GRANTABLE · action 政策表；CEO+worker）
        BrowserTool,
        # Host 第三能力面：单一 ``host``（schema NEVER · action 政策表 · host_class）
        HostTool,
    )
