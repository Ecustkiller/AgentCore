"""Filesystem primitives for ``ServerWorkspace``.

The workspace sandbox boundary (path-traversal guard) and the content-scan
helpers live here, behind the ``WorkspaceBackend`` seam. Tools no longer touch
these directly — they go through ``ServerWorkspace`` — so this is the single
audited place where user-supplied paths are resolved against the root.

Ignore rules are **two-tier** (双模式工作区 · 系统文件隐藏), aligned with
desktop ``apps/desktop/src/main/fs/workspaceIgnore.ts``:

* **System noise** — hidden from both AI and user file UI (``.agentcore`` /
  ``.git`` / ``node_modules`` / caches / ``*.db`` / ``*.pyc`` …).
* **AI noise** — media / archives / fonts / native objects excluded only from
  AI views (``index_files`` / ``list_tree`` / ``grep`` / ``file_list``). User UI
  ``list`` keeps them visible (AI-generated images are deliverables).
"""

from pathlib import Path

# --- System noise (AI + user UI) ---
# Directory set = union with desktop ``LIST_FILES_SKIP_DIRS``. Keep in sync.
IGNORED_DIRS: frozenset[str] = frozenset(
    {
        ".agentcore",
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
        ".turbo",
        ".cache",
        "coverage",
        ".idea",
        ".vscode",
        "dist",
        "build",
        ".next",
        ".nuxt",
        ".vite",
        "out",
        "target",
    }
)

# Indexes + pure bytecode caches — never useful in the file panel either.
SYSTEM_IGNORED_FILE_SUFFIXES: frozenset[str] = frozenset(
    {
        ".db",
        ".sqlite",
        ".sqlite3",
        ".pyc",
        ".pyo",
    }
)

# --- AI noise (AI views only; user UI must still show these) ---
# Keep in sync with desktop ``AI_NOISE_FILE_SUFFIXES``.
AI_NOISE_FILE_SUFFIXES: frozenset[str] = frozenset(
    {
        ".class",
        ".o",
        ".a",
        ".lib",
        ".so",
        ".dylib",
        ".dll",
        ".exe",
        ".wasm",
        ".bin",
        ".dat",
        ".pack",
        ".idx",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".ico",
        ".bmp",
        ".mp3",
        ".mp4",
        ".wav",
        ".webm",
        ".zip",
        ".tar",
        ".gz",
        ".tgz",
        ".bz2",
        ".7z",
        ".rar",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
    }
)

# Combined AI-perspective suffixes (system ∪ AI noise). Prefer the tiered helpers
# below; this alias exists for callers / tests that mean "hide from AI".
IGNORED_FILE_SUFFIXES: frozenset[str] = SYSTEM_IGNORED_FILE_SUFFIXES | AI_NOISE_FILE_SUFFIXES

MAX_FILE_BYTES = 2_000_000  # skip files larger than ~2 MB during content scans


def is_ignored_dir_name(name: str) -> bool:
    """Whether a single path segment is a system-noise directory."""
    return name in IGNORED_DIRS


def _suffix_match(name: str, suffixes: frozenset[str]) -> bool:
    lower = name.lower()
    return any(lower.endswith(suf) for suf in suffixes)


def is_system_ignored_file_name(name: str) -> bool:
    """Whether a file basename is system noise (hidden from UI and AI)."""
    return _suffix_match(name, SYSTEM_IGNORED_FILE_SUFFIXES)


def is_ai_noise_file_name(name: str) -> bool:
    """Whether a file basename is AI-only noise (still visible in user UI)."""
    return _suffix_match(name, AI_NOISE_FILE_SUFFIXES)


def is_ignored_file_name(name: str) -> bool:
    """Whether a file basename should be omitted from AI listings / indexes."""
    return _suffix_match(name, IGNORED_FILE_SUFFIXES)


def is_ignored_relpath(relpath: str) -> bool:
    """Whether a workspace-relative POSIX path should be omitted from AI listings.

    True when any directory segment is in :data:`IGNORED_DIRS` or the final
    file name matches :data:`IGNORED_FILE_SUFFIXES` (system ∪ AI noise).
    """
    parts = [p for p in relpath.replace("\\", "/").split("/") if p and p != "."]
    if not parts:
        return False
    *dirs, name = parts
    if any(is_ignored_dir_name(d) for d in dirs):
        return True
    return is_ignored_file_name(name)


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
