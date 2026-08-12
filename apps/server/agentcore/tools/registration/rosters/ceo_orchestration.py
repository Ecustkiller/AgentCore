"""CEO orchestration surface roster (``ToolSurface.CEO_ORCHESTRATION``).

Append CEO catalog / wire tools here. Order is part of the public surface; keep
relative order when inserting.
"""

from __future__ import annotations


def load_roster() -> tuple[type, ...]:
    from agentcore.tools.builtin.ask_user import AskUserTool
    from agentcore.tools.builtin.board_ops import BoardOpsTool
    from agentcore.tools.builtin.board_read import BoardReadTool
    from agentcore.tools.builtin.consult import ConsultTool
    from agentcore.tools.builtin.debate import DebateTool
    from agentcore.tools.builtin.delegate import DelegateTool
    from agentcore.tools.builtin.project_fs import (
        ListProjectDirTool,
        ReadProjectFileTool,
    )
    from agentcore.tools.builtin.projects import (
        CreateProjectTool,
        ListProjectsTool,
        ResolveProjectTool,
    )
    from agentcore.tools.builtin.read_image import ReadImageTool
    from agentcore.tools.builtin.remember import RememberTool
    from agentcore.tools.builtin.replan import ReplanTool
    from agentcore.tools.builtin.update_project_profile import UpdateProjectProfileTool

    return (
        DelegateTool,
        ReplanTool,
        DebateTool,
        ConsultTool,
        ListProjectsTool,
        ResolveProjectTool,
        CreateProjectTool,
        ListProjectDirTool,
        ReadProjectFileTool,
        RememberTool,
        UpdateProjectProfileTool,
        AskUserTool,
        ReadImageTool,
        BoardOpsTool,
        BoardReadTool,
    )
