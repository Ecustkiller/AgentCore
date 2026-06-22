"""Workspace overview — the CEO's live ``<workspace_context>`` orientation block.

工作区上下文（取代「向量 RAG」的轻量方案）。Instead of a pre-built embedding index (which
goes stale the moment a file changes and needs an embedder + pgvector), this gives the
entry CEO agent a compact, NEWEST-FIRST listing of the files already on disk in the
conversation's workspace, regenerated fresh every turn from the live
``WorkspaceBackend`` — so it is never stale and carries zero new infra. The agent reads
the actual files on demand via the existing ``file_read`` / ``grep`` tools (agentic
retrieval, the主路); this block just saves it a blind ``file_list`` round and tells it
what is there to delegate around.

Best-effort by contract: no backend, no indexing support, an empty workspace, or a
listing failure all yield ``""`` (the caller omits the block) — workspace awareness is
an enhancement, never a hard dependency (same posture as ``memory`` / global search).

Workers do NOT use this — they already receive the richer per-run manifest
(``runs/executor_context._workspace_manifest``: teammate products + pre-existing
files). This is the CEO-only counterpart.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

# Bounds so a large workspace can't bloat the CEO's per-turn prompt: a file-count cap
# AND a char budget (whichever binds first). Mirrors the worker manifest's posture
# (runs/constants.WORKSPACE_MANIFEST_*); kept local to avoid a context→runs import.
OVERVIEW_MAX_FILES = 40
OVERVIEW_CHAR_BUDGET = 1800


async def _safe_index(backend: WorkspaceBackend) -> list[str]:
    """Newest-first workspace file paths; best-effort (``[]`` on any failure).

    Newest-first (``index_files(order="recent")``) so a big tree spends the budget on
    the most-recently-touched files (uploads / latest outputs), not whatever sorts
    alphabetically first. Duck-typed + guarded so a backend without ``index_files``
    (or a dropped desktop in local mode) degrades to "" rather than failing the turn.
    """
    index = getattr(backend, "index_files", None)
    if index is None:
        return []
    try:
        paths, _truncated = await index(order="recent")
        return list(paths)
    except Exception as e:  # noqa: BLE001 — overview is best-effort, never fail a turn
        logger.debug("workspace.overview_index_failed", error=str(e))
        return []


async def build_workspace_overview(backend: WorkspaceBackend | None) -> str:
    """Build the CEO's ``<workspace_context>`` block, or ``""`` when nothing to show.

    Returns ``""`` for a missing backend, an empty / unindexable workspace, or a
    listing failure. Otherwise renders a capped, newest-first file list with an elision
    line when more files remain than the caps allow.
    """
    if backend is None:
        return ""
    paths = await _safe_index(backend)
    if not paths:
        return ""

    lines: list[str] = []
    used = 0
    for path in paths:
        line = f"- {path}"
        if len(lines) >= OVERVIEW_MAX_FILES or used + len(line) + 1 > OVERVIEW_CHAR_BUDGET:
            break
        lines.append(line)
        used += len(line) + 1

    remaining = len(paths) - len(lines)
    if remaining > 0:
        lines.append(f"……另有 {remaining} 个文件未列出（用 file_list 看完整列表）")

    body = "\n".join(lines)
    return (
        "<workspace_context>\n"
        "当前对话工作区里已有以下文件（最近更新在前）；需要其内容时直接用 file_read / grep "
        "查看即可，不必先 file_list：\n"
        f"{body}\n"
        "</workspace_context>"
    )
