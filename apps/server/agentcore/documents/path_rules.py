"""Path-scoped user rules: glob match against a desk-relative path.

``*`` does not cross ``/``. ``**`` does. A pattern with no slash matches only
at the desk root (``*.tsx`` is ``App.tsx``, not ``src/App.tsx``). A pattern
that matches every relative path is unbounded and counts as 常驻.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SPLIT = re.compile(r"[,，、]")
_UNBOUNDED = frozenset({"*", "**", "**/*", "**/**"})


def normalize_rel_path(path: str) -> str:
    text = (path or "").replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    return text.lstrip("/")


def parse_path_patterns(raw: str) -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for part in _SPLIT.split(raw or ""):
        token = normalize_rel_path(part.strip().strip("'\""))
        if not token or token in seen:
            continue
        seen.add(token)
        out.append(token)
    return tuple(out)


def pattern_is_unbounded(pattern: str) -> bool:
    return normalize_rel_path(pattern) in _UNBOUNDED


def patterns_are_unbounded(patterns: tuple[str, ...]) -> bool:
    return any(pattern_is_unbounded(p) for p in patterns)


def glob_match(pattern: str, rel_path: str) -> bool:
    """True when ``rel_path`` matches one workspace-relative glob."""
    pat = normalize_rel_path(pattern)
    rel = normalize_rel_path(rel_path)
    if not pat or not rel or rel.endswith("/"):
        return False
    if pattern_is_unbounded(pat):
        return True
    return _glob_regex(pat).fullmatch(rel) is not None


def _glob_regex(pattern: str) -> re.Pattern[str]:
    parts: list[str] = ["^"]
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            parts.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            parts.append(".*")
            i += 2
        elif pattern[i] == "*":
            parts.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            parts.append("[^/]")
            i += 1
        else:
            parts.append(re.escape(pattern[i]))
            i += 1
    parts.append("$")
    return re.compile("".join(parts))


@dataclass(frozen=True)
class PathRule:
    """One bounded path rule the model must follow when a path matches."""

    name: str
    description: str
    patterns: tuple[str, ...]
    body: str

    def matches(self, rel_path: str) -> bool:
        return any(
            glob_match(pattern, rel_path)
            for pattern in self.patterns
            if not pattern_is_unbounded(pattern)
        )


def render_path_index(rules: tuple[PathRule, ...] | list[PathRule]) -> str:
    """Stable one-line index. Empty when there is nothing to show."""
    ordered = tuple(sorted(rules, key=lambda rule: rule.name))
    if not ordered:
        return ""
    lines = [
        "<路径约定>",
        "碰到匹配路径就遵守这一句。全文附在该次读或写旁边。",
    ]
    for rule in ordered:
        patterns = "、".join(rule.patterns)
        lines.append(f"- {patterns}：{rule.description}")
    lines.append("</路径约定>")
    return "\n".join(lines)


def path_rule_note(rules: tuple[PathRule, ...] | list[PathRule], rel_path: str) -> str:
    """Full bodies for rules that match ``rel_path``, or empty."""
    hits = [rule for rule in rules if rule.matches(rel_path)]
    if not hits:
        return ""
    lines = ["<路径约定全文>"]
    for rule in sorted(hits, key=lambda item: item.name):
        lines.append(f"### {rule.name}\n{rule.body.strip()}")
    lines.append("</路径约定全文>")
    return "\n".join(lines)


def attachment_rel_paths(attachments: object) -> list[str]:
    """Structured file paths already on this turn. Skips pinned documents."""
    if not isinstance(attachments, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for att in attachments:
        if not isinstance(att, dict) or att.get("kind") == "document":
            continue
        raw = ""
        for key in ("workspace_path", "path", "claimed_workspace_path"):
            value = att.get(key)
            if isinstance(value, str) and value.strip():
                raw = value.strip()
                break
        if not raw or raw in seen:
            continue
        seen.add(raw)
        out.append(raw)
    return out


def path_rules_note_for_paths(
    rules: tuple[PathRule, ...] | list[PathRule], rel_paths: list[str]
) -> str:
    """Full bodies for every rule that matches at least one known path."""
    hit: dict[str, PathRule] = {}
    for rel in rel_paths:
        for rule in rules:
            if rule.name not in hit and rule.matches(rel):
                hit[rule.name] = rule
    if not hit:
        return ""
    lines = ["<路径约定全文>"]
    for rule in sorted(hit.values(), key=lambda item: item.name):
        lines.append(f"### {rule.name}\n{rule.body.strip()}")
    lines.append("</路径约定全文>")
    return "\n".join(lines)
