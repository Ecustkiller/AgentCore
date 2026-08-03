"""Static heuristics for workspace-destructive delete shapes (script / shell).

Used by the safety breaker (P2 top-level tree gate) and the Local turn-baseline
gate (P0a/b). This is a **defense-in-depth blacklist**, not a security boundary:
patterns catch common recursive-delete shapes (``shutil.rmtree``, ``rm -rf``,
``Remove-Item -Recurse``, …). They do **not** intercept every dangerous command.

Cleanup-directory whitelist (``node_modules`` / ``.venv`` / …) is intentionally
excluded so ordinary dependency cleanup does not trip FORCE_APPROVAL or the
baseline gate. Misclassification risk: unusual top-level names that are legitimate
cleanup still require approval — stack with Local zip rollback (P0), do not rely
on this heuristic alone.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# P2 whitelist — ordinary build/dependency cleanup; do not false-block.
CLEANUP_WHITELIST: frozenset[str] = frozenset(
    {
        "node_modules",
        ".venv",
        "venv",
        "dist",
        "build",
        ".next",
        "__pycache__",
        ".git",
    }
)

# Bare workspace / drive roots — catastrophic; prefer existing fuse / rm_root rules
# when they match. Still mark as top-level project for the P2 path when reached.
_CATASTROPHIC_TARGETS: frozenset[str] = frozenset(
    {
        "",
        ".",
        "..",
        "/",
        "~",
        "*",
        "/*",
        "$HOME",
        "${HOME}",
        "%USERPROFILE%",
    }
)


@dataclass(frozen=True, slots=True)
class DestructiveFsHit:
    """Result of scanning free-form command/code for recursive workspace deletes."""

    kind: Literal["recursive_delete"]
    """Stable kind for tests / audit."""

    targets: tuple[str, ...]
    """Extracted path tokens (may be empty when the callee used a variable)."""

    top_level_project: bool
    """True when at least one known target is a top-level non-whitelist name."""

    whitelist_only: bool
    """True when every known target is on :data:`CLEANUP_WHITELIST` (and non-empty)."""


def is_cleanup_whitelist_name(name: str) -> bool:
    """True when ``name`` (single path segment) is an ordinary cleanup directory."""
    token = (name or "").strip().strip("/\\")
    if not token:
        return False
    # Last segment only (``./node_modules`` / ``foo/node_modules``).
    segment = token.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return segment in CLEANUP_WHITELIST


def _normalize_target_token(raw: str) -> str:
    text = (raw or "").strip().strip("\"'")
    text = text.replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text.rstrip("/")


def _path_segments(token: str) -> list[str]:
    norm = _normalize_target_token(token)
    if not norm:
        return []
    return [p for p in norm.split("/") if p and p != "."]


def _classify_targets(targets: list[str]) -> tuple[bool, bool]:
    """Return ``(top_level_project, whitelist_only)`` for extracted targets."""
    known = [_normalize_target_token(t) for t in targets if _normalize_target_token(t)]
    if not known:
        # Variable / unparsed callee — treat as destructive but not proven top-level.
        return False, False

    whitelist_hits = 0
    top_level = False
    for token in known:
        lower = token.lower()
        if (
            token in _CATASTROPHIC_TARGETS
            or lower in {t.lower() for t in _CATASTROPHIC_TARGETS}
            or re.fullmatch(r"[A-Za-z]:", token)
            or token in {"$", "${}"}
        ):
            top_level = True
            continue
        segments = _path_segments(token)
        if not segments:
            top_level = True
            continue
        if len(segments) == 1:
            name = segments[0]
            if name in CLEANUP_WHITELIST:
                whitelist_hits += 1
            else:
                top_level = True
        elif segments[-1] in CLEANUP_WHITELIST and all(
            s not in _CATASTROPHIC_TARGETS for s in segments[:-1]
        ):
            # Nested cleanup like ``apps/web/node_modules`` — whitelist cleanup.
            whitelist_hits += 1
        # else: nested project path — destructive but not top-level P2

    whitelist_only = bool(known) and whitelist_hits == len(known) and not top_level
    return top_level, whitelist_only


# ── Extraction helpers ───────────────────────────────────────────────────────

_STRING_LIT = r"""(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")"""

# shutil.rmtree("foo") / shutil.rmtree(cwd / "foo") / shutil.rmtree(path)
_SHUTIL_RMTREE_RE = re.compile(
    r"""(?is)\bshutil\s*\.\s*rmtree\s*\(\s*([^)]*)\)"""
)
_BARE_STRING_RE = re.compile(_STRING_LIT)

# rm -rf / rm -fr / rm --recursive [--force]
_RM_RF_RE = re.compile(
    r"""(?is)(?:^|[\s;&|`(])(?:sudo\s+)?rm\b(?P<body>[^\n;|&]*)"""
)
_RM_RECURSIVE_FLAG_RE = re.compile(
    r"""(?is)(?:-rf\b|-fr\b|-r\b|--recursive\b)"""
)

# Remove-Item ... -Recurse (PowerShell)
_REMOVE_ITEM_RE = re.compile(
    r"""(?is)Remove-Item\b(?P<body>[^\n;|&]*)"""
)

# rimraf / npx rimraf
_RIMRAF_RE = re.compile(
    r"""(?is)(?:^|[\s;&|`(])(?:npx\s+)?rimraf\b(?P<body>[^\n;|&]*)"""
)


def _strings_from_rmtree_args(args_blob: str) -> list[str]:
    found: list[str] = []
    for m in _BARE_STRING_RE.finditer(args_blob):
        lit = m.group(0)
        found.append(lit[1:-1])  # strip quotes
    return found


def _shell_path_tokens(body: str) -> list[str]:
    """Split a shell argument body into path-like tokens (best-effort)."""
    tokens: list[str] = []
    # Quoted first.
    for m in re.finditer(r"(?:'([^']*)'|\"([^\"]*)\")", body):
        tokens.append(m.group(1) if m.group(1) is not None else (m.group(2) or ""))
    # Unquoted words that look like paths (skip flags).
    stripped = re.sub(r"'[^']*'|\"[^\"]*\"", " ", body)
    for word in stripped.split():
        if word.startswith("-"):
            continue
        if word in {"sudo", "rm", "Remove-Item", "rimraf", "npx"}:
            continue
        tokens.append(word)
    return tokens


def scan_destructive_fs(text: str) -> DestructiveFsHit | None:
    """Scan free-form command/code for recursive workspace-delete shapes.

    Returns ``None`` when no recursive-delete heuristic matches. Whitelist-only
    cleanup still returns a hit with ``whitelist_only=True`` so callers can skip
    gating without re-parsing.
    """
    if not text or not text.strip():
        return None

    targets: list[str] = []
    matched = False

    for m in _SHUTIL_RMTREE_RE.finditer(text):
        matched = True
        targets.extend(_strings_from_rmtree_args(m.group(1)))

    for m in _RM_RF_RE.finditer(text):
        body = m.group("body") or ""
        if not _RM_RECURSIVE_FLAG_RE.search(body) and not re.search(
            r"(?i)(?:-r\b.*-f\b|-f\b.*-r\b)", body
        ):
            continue
        matched = True
        targets.extend(_shell_path_tokens(body))

    for m in _REMOVE_ITEM_RE.finditer(text):
        body = m.group("body") or ""
        if not re.search(r"(?i)-Recurse\b", body):
            continue
        matched = True
        targets.extend(_shell_path_tokens(body))

    for m in _RIMRAF_RE.finditer(text):
        matched = True
        targets.extend(_shell_path_tokens(m.group("body") or ""))

    if not matched:
        return None

    # Dedupe while preserving order.
    seen: set[str] = set()
    uniq: list[str] = []
    for t in targets:
        norm = _normalize_target_token(t)
        key = norm.lower()
        if not norm or key in seen:
            continue
        seen.add(key)
        uniq.append(norm)

    top_level, whitelist_only = _classify_targets(uniq)
    return DestructiveFsHit(
        kind="recursive_delete",
        targets=tuple(uniq),
        top_level_project=top_level,
        whitelist_only=whitelist_only,
    )


def requires_destructive_baseline_gate(hit: DestructiveFsHit | None) -> bool:
    """True when Local must ensure a turn zip baseline before executing."""
    return not (hit is None or hit.whitelist_only)


def requires_top_level_tree_gate(hit: DestructiveFsHit | None) -> bool:
    """True when P2 FORCE_APPROVAL for top-level whole-project tree applies."""
    return bool(hit is not None and not hit.whitelist_only and hit.top_level_project)
