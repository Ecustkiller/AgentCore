"""Context subsystem: unified system-prompt assembly + on-demand context sources.

上下文注入统一. Houses the injection-side spine (:class:`ContextAssembler`) and — as
the later steps land — the shared "目录 + 按需取" protocol (``Consultable``) and its
sources (skills, rules, workspace). The OUTPUT side (tool execution, memory writes)
is intentionally NOT here: unification is injection-side only (文档「守恒律」: 复杂度
搬家不消失).
"""

from agentcore.runtime.context.assembler import ContextAssembler
from agentcore.runtime.context.contributor import PromptContributor, SectionOrder
from agentcore.runtime.context.workspace_context import (
    ChannelProfile,
    WorkspaceGitFact,
    build_workspace_context,
    desktop_client_can_bind,
    detect_workspace_git,
    detect_workspace_git_sync,
    format_workspace_git_line,
    resolve_channel_profile,
)
from agentcore.runtime.context.workspace_overview import build_workspace_overview

__all__ = [
    "ChannelProfile",
    "ContextAssembler",
    "PromptContributor",
    "SectionOrder",
    "WorkspaceGitFact",
    "build_workspace_context",
    "build_workspace_overview",
    "detect_workspace_git",
    "detect_workspace_git_sync",
    "desktop_client_can_bind",
    "format_workspace_git_line",
    "resolve_channel_profile",
]
