"""User-rule path helpers — ``.agentcore/规则/*.md`` is the injectable object.

Workspace ``file_*`` tools overlay this catalog onto ``documents`` (not disk).
The address is a reserved prompt-entry path, not a workspace-tree file.
Path classification is pure; IO lives in ``tools.builtin.file_ops.user_rules``.
"""

from __future__ import annotations

from typing import Literal

from agentcore.db.repositories.documents import RULES_DIR_NAME
from agentcore.memory.rules_injection import normalize_rule_filename

RulePathKind = Literal["agentcore_root", "rules_dir", "rule_file", "invalid"]

RULES_CATALOG_ROOT = ".agentcore"
RULES_DIR_REL = f"{RULES_CATALOG_ROOT}/{RULES_DIR_NAME}"
WORKER_RULE_WRITE_MSG = "队员不能改用户规则。请把规则改动交给协调者。"
RULE_TREE_META_MSG = (
    "请用 file_write / file_read / file_delete / file_list 操作"
    f" {RULES_DIR_REL}/ 下的用户规则。"
)


def posix_relpath(raw: str) -> str:
    text = (raw or "").replace("\\", "/").strip()
    if not text or text == ".":
        return ""
    return text.strip("/")


def classify_rule_path(raw: str) -> tuple[RulePathKind | None, str | None]:
    """Classify a path against the user-rule catalog.

    ``None`` kind = not this overlay (ordinary workspace I/O).
    """
    rel = posix_relpath(raw)
    if not rel:
        return None, None
    if rel == RULES_CATALOG_ROOT:
        return "agentcore_root", None
    if rel == RULES_DIR_REL:
        return "rules_dir", None
    prefix = RULES_DIR_REL + "/"
    if not rel.startswith(prefix):
        return None, None
    rest = rel[len(prefix) :]
    if not rest or "/" in rest:
        return "invalid", None
    name = normalize_rule_filename(rest)
    if name is None:
        return "invalid", None
    return "rule_file", name


def rule_entry_relpath(name: str) -> str:
    """Canonical catalog address for a rule basename."""
    return f"{RULES_DIR_REL}/{name}"
