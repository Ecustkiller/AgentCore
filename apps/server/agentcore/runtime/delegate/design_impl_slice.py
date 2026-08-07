"""Design+impl same-grant soft gate: 单 task 同时塞设计+实现 → 软告警.

产品判据：同一 task 的 ``deliverable.artifacts`` 或 task 文案同时含设计段与实现段，
且未在结构上拆开（本批仅 1 个 dict task，或无 ``checkpoint_after`` 且同批无下游
``depends_on``）→ 记一次软告警，不拒收入图、不改图。引擎不自动拆波——靠提示词 +
可选软提示纠正。不扫用户原文。
"""

from __future__ import annotations

import re
from typing import Any

# 设计类路径：DESIGN.md / architecture.md / 文件名含「设计」的 .md
_DESIGN_BASENAME = re.compile(
    r"(?i)^(?:DESIGN|ARCHITECTURE)\.md$"
    r"|^[^/]*设计[^/]*\.md$",
)

# 代码类：典型源码后缀（不含 .md/.json 泛匹配，避免设计稿误伤）
_CODE_EXT = re.compile(
    r"(?i)\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|swift|"
    r"c|cc|cpp|h|hpp|vue|svelte|css|scss|less)$"
)

# task 文案：阶段 A（设计段）+ 阶段 B（实现段）；窄正则，只看 delegate task 字段
_PHASE_DESIGN = re.compile(r"阶段\s*A")
_PHASE_IMPL = re.compile(r"阶段\s*B")


def _norm_path(path: str) -> str:
    return path.replace("\\", "/").strip()


def is_design_artifact_path(path: str) -> bool:
    """True when artifact path looks like a design / architecture markdown."""
    norm = _norm_path(path)
    if not norm:
        return False
    base = norm.rsplit("/", 1)[-1]
    return _DESIGN_BASENAME.search(base) is not None


def is_code_artifact_path(path: str) -> bool:
    """True when artifact path looks like code (package.json / src / electron / 源码后缀)."""
    norm = _norm_path(path)
    if not norm:
        return False
    lower = norm.lower()
    base = lower.rsplit("/", 1)[-1]
    if base == "package.json":
        return True
    parts = [p for p in lower.split("/") if p]
    if "src" in parts or "electron" in parts:
        return True
    return bool(_CODE_EXT.search(base))


def task_text_claims_design_and_impl_phases(task_text: str) -> bool:
    """True when task 文案同时出现阶段 A + 阶段 B（设计段 / 实现段约定标签）。"""
    text = (task_text or "").strip()
    if not text:
        return False
    return (
        _PHASE_DESIGN.search(text) is not None
        and _PHASE_IMPL.search(text) is not None
    )


def _artifacts(task: dict[str, Any]) -> list[str]:
    deliverable = task.get("deliverable")
    if not isinstance(deliverable, dict):
        return []
    raw = deliverable.get("artifacts")
    if not isinstance(raw, list):
        return []
    return [a for a in raw if isinstance(a, str) and a.strip()]


def _task_body(task: dict[str, Any]) -> str:
    raw = task.get("task") or ""
    return raw if isinstance(raw, str) else str(raw)


def _peer_ref(task: dict[str, Any]) -> str:
    tid = task.get("id")
    if isinstance(tid, str) and tid.strip():
        return tid.strip()
    role = task.get("role")
    if isinstance(role, str) and role.strip():
        return role.strip()
    return ""


def _has_design_and_code_artifacts(task: dict[str, Any]) -> bool:
    arts = _artifacts(task)
    if not arts:
        return False
    has_design = any(is_design_artifact_path(a) for a in arts)
    has_code = any(is_code_artifact_path(a) for a in arts)
    return has_design and has_code


def _mixes_design_and_impl(task: dict[str, Any]) -> bool:
    if _has_design_and_code_artifacts(task):
        return True
    return task_text_claims_design_and_impl_phases(_task_body(task))


def _structurally_split(task: dict[str, Any], dict_tasks: list[dict[str, Any]]) -> bool:
    """True when batch already splits this task structurally → 不告警.

    拆开 = 本批 ≥2 dict tasks，且（本 task 有 ``checkpoint_after``，或同批另有
    task 的 ``depends_on`` 引用本 task）。
    """
    if len(dict_tasks) < 2:
        return False
    if task.get("checkpoint_after"):
        return True
    ref = _peer_ref(task)
    if not ref:
        return False
    for other in dict_tasks:
        if other is task:
            continue
        deps = other.get("depends_on")
        if not isinstance(deps, list):
            continue
        if ref in deps:
            return True
    return False


def design_impl_same_grant_soft_message(*, violators: list[dict[str, Any]]) -> str:
    roles = "、".join(
        f"「{(v.get('role') or v.get('id') or '?')}」" for v in violators
    )
    return (
        f"{roles}的 task 在同一 grant 里同时塞了设计与实现——"
        "建议拆成设计波 + 实现波（实现 task 用 `depends_on` 挂设计，"
        "或设计 task 设 `checkpoint_after` 后再开实现）；"
        "本提示不拒收、不改图。"
    )


def check_design_impl_same_grant(tasks: list[Any]) -> str | None:
    """单 task/单 grant 设计+实现混装时返回软告警文案（不拒收）；否则 None."""
    if not isinstance(tasks, list) or not tasks:
        return None

    dict_tasks = [t for t in tasks if isinstance(t, dict)]
    if not dict_tasks:
        return None

    violators: list[dict[str, Any]] = []
    for task in dict_tasks:
        if not _mixes_design_and_impl(task):
            continue
        if _structurally_split(task, dict_tasks):
            continue
        violators.append(task)

    if not violators:
        return None

    return design_impl_same_grant_soft_message(violators=violators)
