"""Workspace backends — the file + execution seam for tools.

``WorkspaceBackend`` is the abstraction every filesystem / code-execution tool
talks to; ``ServerWorkspace`` is the server-side (cloud-mode) implementation.
A desktop-side ``LocalWorkspace`` plugs in later without touching tools/engine.
"""

from agentcore.workspace.protocol import (
    AmbiguousMatch,
    DirEntry,
    GrepHit,
    GrepQuery,
    GrepResult,
    NoMatch,
    NotADirectory,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
    ReplaceOutcome,
    WorkspaceBackend,
    WorkspaceError,
    WorkspaceIOError,
)
from agentcore.workspace.server import ServerWorkspace

__all__ = [
    "WorkspaceBackend",
    "ServerWorkspace",
    "WorkspaceError",
    "OutsideWorkspace",
    "PathNotFound",
    "NotAFile",
    "NotADirectory",
    "NotUTF8",
    "NoMatch",
    "AmbiguousMatch",
    "WorkspaceIOError",
    "DirEntry",
    "GrepHit",
    "GrepQuery",
    "GrepResult",
    "ReplaceOutcome",
]
