"""Filesystem primitives for ``ServerWorkspace``.

The workspace sandbox boundary (path-traversal guard) and the content-scan
helpers live here, behind the ``WorkspaceBackend`` seam. Tools no longer touch
these directly — they go through ``ServerWorkspace`` — so this is the single
audited place where user-supplied paths are resolved against the root.
"""

from pathlib import Path

# Directories that are pure noise for content/file search: VCS internals,
# dependency trees, build artifacts, and tool caches. Pruned during workspace
# walks so a single ``node_modules`` can't make a ``grep`` scan the universe.
IGNORED_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".cache",
        "dist",
        "build",
        ".next",
        ".nuxt",
        ".vite",
        "out",
        "target",
    }
)

MAX_FILE_BYTES = 2_000_000  # skip files larger than ~2 MB during content scans


def resolve_safe_path(workspace: Path, relative_path: str) -> Path | None:
    """Resolve ``relative_path`` against ``workspace``, refusing escapes.

    Returns the resolved absolute path when it stays inside ``workspace`` (or is
    the workspace root itself), or ``None`` when the path traverses outside it
    (``..``, an absolute path, a prefix sibling like ``workspace-evil``) or
    cannot be resolved. This is the single source of truth for the workspace
    sandbox boundary — every filesystem operation must route through it.
    """
    try:
        resolved = (workspace / relative_path).resolve()
        root = workspace.resolve()
        # Containment via the ancestor chain — NOT a string prefix, which would
        # wrongly accept a sibling dir sharing the workspace name as a prefix.
        if resolved != root and root not in resolved.parents:
            return None
        return resolved
    except (ValueError, OSError):
        return None


def normalize_glob(glob_pat: str) -> str | None:
    """Reduce a (possibly path-qualified) glob to a file-NAME pattern.

    We filter by file name only, so ``**/*.py`` and ``src/*.ts`` both collapse to
    their trailing name component (``*.py`` / ``*.ts``). Returns ``None`` for an
    empty filter.
    """
    p = glob_pat.strip().replace("\\", "/")
    if not p:
        return None
    if p.startswith("**/"):
        p = p[3:]
    if "/" in p:
        p = p.rsplit("/", 1)[-1]
    return p or None


def read_text_file(path: Path) -> str | None:
    """Read a regular text file, or ``None`` to skip it.

    Skips symlinks (avoids following links out of the tree or into loops),
    non-regular files, oversized files, and anything that isn't valid UTF-8 text
    (a cheap, reliable binary filter).
    """
    try:
        if path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
    except OSError:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None
