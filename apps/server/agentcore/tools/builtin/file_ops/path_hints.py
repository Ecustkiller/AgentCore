"""Path-not-found landmarks: sibling samples + root-search tip (anti path-guess)."""

from __future__ import annotations

from agentcore.tools.protocol import ToolContext
from agentcore.workspace.protocol import (
    NotADirectory,
    OutsideWorkspace,
    PathNotFound,
    WorkspaceError,
)
from agentcore.workspace.sparse_listing import should_hide_ai_noise_from_list

# When even the parent cannot be listed — steer away from re-guessing common names.
_MISSING_PATH_ROOT_TIP = (
    "（上级目录也找不到。"
    "请从工作区根用 file_list / code_search / grep 定位真实路径；"
    "禁止凭通用目录名（如 src、shared、lib、app）猜测后原样重试同一假路径。）"
)


def parent_dir_of(rel_path: str) -> str:
    """Workspace-relative parent of ``rel_path`` (``.`` when path is top-level)."""
    raw = (rel_path or "").strip().replace("\\", "/").strip("/")
    if not raw or "/" not in raw:
        return "."
    parent = raw.rsplit("/", 1)[0].strip("/")
    return parent or "."


def missing_path_landmark_suffix(*, parent: str, bare_entries: list) -> str:
    """Sibling samples + wider-search tip when parent exists."""
    root = "./" if parent in (".", "") else f"{parent.rstrip('/')}/"
    tips = (
        "可换 file_list(pattern)/grep/code_search 更宽查找后再读"
        "（已知路径仍可直接读）；禁止原样重试同一假路径"
    )
    if not bare_entries:
        return f"（父目录 {root} 存在但当前层无可列样本。{tips}。）"
    sample_parts: list[str] = []
    for entry in bare_entries[:8]:
        sample_parts.append(f"{'d ' if entry.is_dir else 'f '}{entry.path}")
    sample = "；".join(sample_parts)
    more = (
        f" 等共 {len(bare_entries)} 项"
        if len(bare_entries) > 8
        else f"（共 {len(bare_entries)} 项）"
    )
    return (
        f"（父目录 {root} 存在{more}。"
        f"可见同层示例：{sample}。"
        f"{tips}。）"
    )


async def enrich_missing_path_message(
    context: ToolContext,
    rel_path: str,
    *,
    base: str,
) -> str:
    """Append landmark when parent is listable; else a root-search / no-retry tip."""
    parent = parent_dir_of(rel_path)
    try:
        bare = [
            e
            for e in await context.backend.list(parent, "*")
            if e.is_dir
            or not should_hide_ai_noise_from_list(
                e.path,
                materials=context.material_paths,
                reveal_archives=False,
            )
        ]
    except (PathNotFound, NotADirectory, OutsideWorkspace, WorkspaceError):
        return base + _MISSING_PATH_ROOT_TIP
    return base + missing_path_landmark_suffix(parent=parent, bare_entries=bare)
