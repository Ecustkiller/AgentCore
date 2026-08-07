"""Validate client REST path literals against OpenAPI.

Fail-closed gate (run as part of ``pnpm gen:types``):

1. Load path templates from ``apps/server/openapi.json``.
2. Scan production TS/TSX under desktop / mobile / admin for hardcoded
   ``/v1/...`` (and a few non-v1 REST roots).
3. Normalize both sides (strip query; ``${...}`` / ``{name}`` → ``{param}``)
   and require every code path to match an OpenAPI template.

Skips tests / generated artifacts. Known intentional non-route strings live in
``ALLOWLIST`` (prefix checks, docs-only fragments).

Standalone::

    uv run python scripts/validate_rest_paths.py
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OPENAPI = ROOT / "apps" / "server" / "openapi.json"

SCAN_ROOTS = [
    ROOT / "apps" / "desktop" / "src",
    ROOT / "apps" / "mobile" / "src",
    ROOT / "apps" / "admin" / "src",
]

SKIP_DIR_NAMES = {
    "__tests__",
    "node_modules",
    "dist",
    "coverage",
}
SKIP_FILE_SUFFIXES = (
    ".test.ts",
    ".test.tsx",
    ".spec.ts",
    ".spec.tsx",
    ".generated.ts",
)

# Roots that appear in OpenAPI (and client fetch URLs).
_PATH_ROOT = r"(?:/v1/|/livez\b|/readyz\b|/updates/|/shared/)"

# Well-formed string literal: "/v1/..." or '/v1/...'
_STR_LIT = re.compile(
    rf"(?P<q>['\"])(?P<path>{_PATH_ROOT}(?:(?!\1).)*)(?P=q)"
)

# Template literal with only simple ${...} interpolations (no nested backticks).
_TPL_LIT = re.compile(
    rf"`(?P<path>{_PATH_ROOT}(?:[^`$]|\$\{{[^}}]*\}})+)`"
)

# Strip encodeURIComponent(...) wrappers left inside normalized segments.
_ENCODE_WRAP = re.compile(r"encodeURIComponent\(([^)]+)\)")
_INTERP = re.compile(r"\$\{[^}]+\}")
_OPENAPI_PARAM = re.compile(r"\{[^/}]+\}")
_QUERY_OR_HASH = re.compile(r"[?#].*$")

# Non-route (or base-prefix helper) strings that look like paths but are
# intentional. Checked after normalize.
ALLOWLIST: frozenset[str] = frozenset(
    {
        # `wsPath` / `wsBase` helpers — OpenAPI only has sub-routes under
        # `/v1/workspaces/{ws_id}/…`, not the bare workspace id URL.
        "/v1/workspaces/{param}",
    }
)


@dataclass(frozen=True)
class Hit:
    path: str
    file: Path
    line: int


def _normalize(raw: str) -> str | None:
    """Return comparable template, or None if not a concrete route candidate."""
    s = raw.strip()
    if not s:
        return None
    s = _QUERY_OR_HASH.sub("", s)
    # Truncate at non-param interpolation (e.g. query ternary `${qs ? ...}`).
    out: list[str] = []
    i = 0
    while i < len(s):
        if s.startswith("${", i):
            end = s.find("}", i)
            if end < 0:
                return None
            body = s[i + 2 : end]
            # Path params sit after `/` (…/${id}/…). Suffix like `/audit${query}`
            # is a query-string concat — keep the static prefix only.
            after_slash = i > 0 and s[i - 1] == "/"
            is_param = after_slash and (
                re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", body)
                or body.startswith("encodeURIComponent(")
            )
            if is_param:
                out.append("{param}")
                i = end + 1
                continue
            break
        out.append(s[i])
        i += 1
    s = "".join(out)
    s = _ENCODE_WRAP.sub(r"\1", s)
    s = _INTERP.sub("{param}", s)
    s = _OPENAPI_PARAM.sub("{param}", s)
    # Drop trailing junk from greedy extracts (never strip `}` — path params).
    s = s.rstrip(".,);:]")
    if not s:
        return None
    if s.endswith("/"):
        # Prefix-only (e.g. "/v1/auth/") — not a route match target.
        return None
    if "$" in s or re.search(r"\{(?!param\})", s):
        return None
    return s


def _openapi_normalized() -> set[str]:
    data = json.loads(OPENAPI.read_text(encoding="utf-8"))
    paths = data.get("paths")
    if not isinstance(paths, dict) or not paths:
        raise RuntimeError("openapi.json has no paths object")
    out: set[str] = set()
    for p in paths:
        n = _normalize(str(p))
        if n:
            out.add(n)
    return out


def _should_skip_file(path: Path) -> bool:
    name = path.name
    if not (name.endswith(".ts") or name.endswith(".tsx")):
        return True
    if name.endswith(SKIP_FILE_SUFFIXES):
        return True
    if name == "paths.generated.ts":
        return True
    parts = set(path.parts)
    return bool(parts & SKIP_DIR_NAMES)


def _line_is_comment(line: str, idx_in_line: int) -> bool:
    before = line[:idx_in_line]
    if "//" in before:
        return True
    stripped = line.lstrip()
    return stripped.startswith("*") or stripped.startswith("/*")


def _extract_from_text(text: str, file: Path) -> list[Hit]:
    hits: list[Hit] = []
    lines = text.splitlines()
    # Join for multiline template search, but map positions via line scan of
    # each match's start offset.
    for cre in (_STR_LIT, _TPL_LIT):
        for m in cre.finditer(text):
            raw = m.group("path")
            # Map to line number.
            line_no = text.count("\n", 0, m.start()) + 1
            line = lines[line_no - 1] if 0 < line_no <= len(lines) else ""
            col = m.start() - (text.rfind("\n", 0, m.start()) + 1)
            if _line_is_comment(line, col):
                continue
            norm = _normalize(raw)
            if norm is None:
                continue
            if norm in ALLOWLIST:
                continue
            hits.append(Hit(path=norm, file=file, line=line_no))
    return hits


def collect_hits() -> list[Hit]:
    hits: list[Hit] = []
    for root in SCAN_ROOTS:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or _should_skip_file(path):
                continue
            text = path.read_text(encoding="utf-8")
            hits.extend(_extract_from_text(text, path))
    return hits


def main() -> None:
    openapi = _openapi_normalized()
    hits = collect_hits()
    missing: list[Hit] = []
    seen: set[tuple[str, str, int]] = set()
    for h in hits:
        key = (h.path, str(h.file), h.line)
        if key in seen:
            continue
        seen.add(key)
        if h.path not in openapi:
            missing.append(h)

    if missing:
        print("REST path literals not in OpenAPI:", file=sys.stderr)
        for h in sorted(missing, key=lambda x: (str(x.file), x.line, x.path)):
            rel = h.file.relative_to(ROOT)
            print(f"  {rel}:{h.line}: {h.path}", file=sys.stderr)
        print(
            f"\n{len(missing)} path(s) missing from OpenAPI "
            f"({len(openapi)} templates). Fix the client URL or regenerate "
            f"OpenAPI (`pnpm gen:types`).",
            file=sys.stderr,
        )
        raise SystemExit(1)

    unique = sorted({h.path for h in hits})
    print(
        f"validate_rest_paths: ok — {len(hits)} literals / "
        f"{len(unique)} unique templates match OpenAPI ({len(openapi)} routes)"
    )


if __name__ == "__main__":
    main()
