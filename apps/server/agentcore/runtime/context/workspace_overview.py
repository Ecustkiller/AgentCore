"""Workspace overview — the CEO's live ``<workspace_file_index>`` orientation block.

工作区文件索引（取代「向量 RAG」的轻量方案）。Instead of a pre-built embedding index (which
goes stale the moment a file changes and needs an embedder + pgvector), this gives the
entry CEO agent a compact, NEWEST-FIRST listing of the files already on disk in the
conversation's workspace, regenerated fresh every turn from the live
``WorkspaceBackend`` — so it is never stale and carries zero new infra. The block is
PATHS ONLY (no file bodies); the agent must call ``file_read`` / ``grep`` for content
(agentic retrieval, the主路).

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
from agentcore.runtime.context.project_profile import (
    detect_project_profile,
    render_project_profile,
)

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
    """Build the CEO's ``<workspace_file_index>`` block, or ``""`` when nothing to show.

    Returns ``""`` for a missing backend, an empty / unindexable workspace with no
    detectable project profile, or a listing failure. Otherwise renders a best-effort
    project fingerprint (when detectable) plus a capped, newest-first file list with an
    elision line when more files remain than the caps allow.
    """
    if backend is None:
        return ""

    profile_text = render_project_profile(await detect_project_profile(backend))
    paths = await _safe_index(backend)
    if not paths and not profile_text:
        return ""

    sections: list[str] = []
    if profile_text:
        sections.append(f"当前工作区项目概览：\n{profile_text}")

    if paths:
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

        file_intro = (
            "以下为本对话工作区中产生或上传的文件路径索引（最近更新在前）。"
            "列表仅为路径，不含正文内容；需要了解某个文件的内容时，必须调用 file_read（或 grep）读取："
        )
        sections.append(f"{file_intro}\n" + "\n".join(lines))

    body = "\n\n".join(sections)
    return f"<workspace_file_index>\n{body}\n</workspace_file_index>"
