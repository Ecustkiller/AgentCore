"""``artifact_dir``：显式目录 + 已声明 artifacts 推导出的公共父目录。

落点只认显式来源（按序）：已声明 ``artifacts`` 推导出的目录 → 显式
``deliverable.artifact_dir``。裸文件名保持声明原样，不发明落点柜。空
``artifacts`` 且无显式 dir 不钉目录。运行时**不**扫 role / task 自由文。

**验收 vs 归属分键**：``artifact_dir`` / 目录前缀 / 通配 = 写时目录与 sibling
分键，**不是**收口催搬。仅目录未命中且已有落盘 → 认实际路径，不发软待办。
具体文件路径 = C3 归属与 sibling 互斥。裸目录**永不**注入 ``artifacts`` 冒充归属键。

不做：``write`` 启发式改写、根目录搬迁。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.runtime.runs.types import Deliverable, RunSpec


def normalize_artifact_dir(path: str) -> str:
    """Workspace-relative POSIX dir without trailing slash."""
    return path.replace("\\", "/").strip().lstrip("./").rstrip("/")


def _acceptance_dir_for_path(path: str) -> str:
    """Parent directory of one declared artifact pattern, or ``\"\"`` for a bare file."""
    raw = path.replace("\\", "/").strip()
    if not raw:
        return ""
    if any(ch in raw for ch in "*?["):
        cut = len(raw)
        for ch in "*?[":
            idx = raw.find(ch)
            if idx != -1:
                cut = min(cut, idx)
        raw = raw[:cut].rstrip("/")
        if not raw:
            return ""
        return normalize_artifact_dir(raw)

    ended_as_dir = raw.endswith("/")
    p = normalize_artifact_dir(raw)
    if not p:
        return ""
    if ended_as_dir:
        return p
    if "/" not in p:
        return ""
    return p.rsplit("/", 1)[0]


def _dir_from_artifacts(artifacts: list[str]) -> str:
    """Common parent of nested / directory-shaped artifacts, or ``\"\"``."""
    dirs: list[str] = []
    for raw in artifacts:
        if not isinstance(raw, str):
            continue
        d = _acceptance_dir_for_path(raw)
        if d:
            dirs.append(d)
    if not dirs:
        return ""
    common = dirs[0].split("/")
    for d in dirs[1:]:
        parts = d.split("/")
        n = 0
        while n < len(common) and n < len(parts) and common[n] == parts[n]:
            n += 1
        common = common[:n]
        if not common:
            return ""
    return "/".join(common)


def resolve_artifact_dir(deliverable: Deliverable) -> str:
    """Resolve a landing directory from declared paths / explicit dir, or ``\"\"``.

    Bare filenames do not invent a dump. Role / task free text is not an input.
    """
    derived = _dir_from_artifacts(list(deliverable.artifacts or []))
    if derived:
        return derived
    return normalize_artifact_dir(deliverable.artifact_dir)


def is_acceptance_only_artifact_pattern(path: str) -> bool:
    """True for directory / glob patterns that must not become C3 ownership keys."""
    raw = path.replace("\\", "/").strip()
    if not raw:
        return True
    if raw.endswith("/") or any(ch in raw for ch in "*?["):
        return True
    p = normalize_artifact_dir(raw)
    return not p


def is_file_ownership_path(path: str) -> bool:
    """Concrete file path eligible for sibling / ownership declare."""
    return not is_acceptance_only_artifact_pattern(path)


def apply_artifact_dir_defaults(deliverable: Deliverable) -> None:
    """Fill ``artifact_dir``; relocate bare filenames only under an explicit dir.

    Empty ``artifacts`` stays empty — no injected ``[dir/]``. Nested declared
    paths stay nested. Bare names without an explicit ``artifact_dir`` stay
    workspace-relative as declared.
    """
    explicit = normalize_artifact_dir(deliverable.artifact_dir)
    derived = _dir_from_artifacts(list(deliverable.artifacts or []))
    resolved = derived or explicit
    if resolved:
        deliverable.artifact_dir = resolved

    if not deliverable.artifacts:
        return

    relocated: list[str] = []
    for raw in deliverable.artifacts:
        if not isinstance(raw, str):
            continue
        raw_s = raw.replace("\\", "/").strip()
        if not raw_s:
            continue
        if is_acceptance_only_artifact_pattern(raw_s):
            if any(ch in raw_s for ch in "*?["):
                relocated.append(normalize_artifact_dir(raw_s) or raw_s)
            else:
                bare = normalize_artifact_dir(raw_s)
                if bare:
                    relocated.append(f"{bare}/")
            continue
        norm = normalize_artifact_dir(raw_s)
        if not norm:
            continue
        if "/" not in norm and explicit:
            relocated.append(f"{explicit}/{norm}")
        else:
            relocated.append(norm)
    from agentcore.workspace._paths import sanitize_write_relpath

    deliverable.artifacts = [
        p
        if p.endswith("/") or any(ch in p for ch in "*?[")
        else sanitize_write_relpath(p)
        for p in relocated
    ]


def apply_artifact_dir_to_spec(spec: RunSpec) -> None:
    """Apply ``artifact_dir`` defaults to one plan node (in-place)."""
    if spec.deliverable is None:
        return
    apply_artifact_dir_defaults(spec.deliverable)


def apply_artifact_dir_to_specs(specs: list[RunSpec]) -> None:
    for spec in specs:
        apply_artifact_dir_to_spec(spec)


def apply_artifact_dir_to_plan(plan: object) -> None:
    nodes = getattr(plan, "nodes", None) or []
    apply_artifact_dir_to_specs(list(nodes))


__all__ = [
    "apply_artifact_dir_defaults",
    "apply_artifact_dir_to_plan",
    "apply_artifact_dir_to_spec",
    "apply_artifact_dir_to_specs",
    "is_acceptance_only_artifact_pattern",
    "is_file_ownership_path",
    "normalize_artifact_dir",
    "resolve_artifact_dir",
]
