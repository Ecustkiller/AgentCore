"""CEO orchestration surface roster (``ToolSurface.CEO_ORCHESTRATION``).

Append CEO catalog / wire tools here. Order is part of the public surface; keep
relative order when inserting.
"""

from __future__ import annotations


def load_roster() -> tuple[type, ...]:
    from agentcore.tools.builtin.ask_user import AskUserTool
    from agentcore.tools.builtin.consult import ConsultTool
    from agentcore.tools.builtin.debate import DebateTool
    from agentcore.tools.builtin.delegate import DelegateTool
    from agentcore.tools.builtin.folders import (
        CreateFolderTool,
        DeleteFolderTool,
        FoldersTool,
    )
    from agentcore.tools.builtin.replan import ReplanTool
    from agentcore.tools.builtin.table_ops import TableOpsTool
    from agentcore.tools.builtin.table_read import TableReadTool

    return (
        DelegateTool,
        ReplanTool,
        DebateTool,
        ConsultTool,
        FoldersTool,
        CreateFolderTool,
        DeleteFolderTool,
        AskUserTool,
        TableOpsTool,
        TableReadTool,
    )
