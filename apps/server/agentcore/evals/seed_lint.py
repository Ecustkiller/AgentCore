"""种子用例静态校验（评估体系 §五 / §八 零 LLM 自测）.

纯结构检查，不跑模型：必填字段、枚举合法、引用的 check 名已注册、samples≥1 等。
用于 per-PR 硬门禁（用例写错立刻挂），也被 loader 复用以早失败。
"""

from __future__ import annotations

from typing import Any

from agentcore.evals.checks import CHECK_NAMES

_CATEGORIES = {"qa", "retrieval", "team", "tool_use", "no_fabrication", "routing"}
_PATHS = {"single", "team"}
_TOOLSETS = {"ceo", "worker"}
_REQUIRED = ("id", "category", "user_message")


def lint_case(raw: dict[str, Any]) -> list[str]:
    """返回一条用例的所有结构错误（空列表 = 合法）。"""
    errors: list[str] = []
    cid = raw.get("id") or "<no-id>"

    for f in _REQUIRED:
        if not raw.get(f):
            errors.append(f"[{cid}] 缺必填字段 {f!r}")

    category = raw.get("category")
    if category is not None and category not in _CATEGORIES:
        errors.append(f"[{cid}] category={category!r} 非法（须属 {sorted(_CATEGORIES)}）")

    path = raw.get("path", "single")
    if path not in _PATHS:
        errors.append(f"[{cid}] path={path!r} 非法（须属 {sorted(_PATHS)}）")

    toolset = raw.get("toolset", "ceo")
    if toolset not in _TOOLSETS:
        errors.append(f"[{cid}] toolset={toolset!r} 非法（须属 {sorted(_TOOLSETS)}）")

    checks = raw.get("checks", [])
    if not isinstance(checks, list):
        errors.append(f"[{cid}] checks 须为列表")
    else:
        for i, spec in enumerate(checks):
            if not isinstance(spec, dict) or "name" not in spec:
                errors.append(f"[{cid}] checks[{i}] 须为含 name 的对象")
            elif spec["name"] not in CHECK_NAMES:
                errors.append(f"[{cid}] checks[{i}].name={spec['name']!r} 未注册")

    if not checks and not raw.get("rubric"):
        errors.append(f"[{cid}] 既无 checks 也无 rubric——该用例不会判定任何东西")

    try:
        samples = int(raw.get("samples", 1))
        if samples < 1:
            errors.append(f"[{cid}] samples={samples} 须 ≥1")
    except (TypeError, ValueError):
        errors.append(f"[{cid}] samples 须为整数")

    return errors


def lint_suite(cases: list[dict[str, Any]]) -> list[str]:
    """校验整套用例：逐例结构 + 全局 id 唯一。"""
    errors: list[str] = []
    seen: set[str] = set()
    for raw in cases:
        errors.extend(lint_case(raw))
        cid = raw.get("id")
        if cid:
            if cid in seen:
                errors.append(f"[{cid}] id 重复")
            seen.add(cid)
    return errors


# --- 对比评估用例校验（团队 vs 单体）—— 见 docs/07-规划/多Agent对比评估设计.md ---

_ARCHETYPES = {"parallel_research", "debate", "cross_domain", "simple"}
_ARMS = {"single", "team", "matched_single"}
_COMPARISON_REQUIRED = ("id", "archetype", "user_message")


def lint_comparison_case(raw: dict[str, Any]) -> list[str]:
    """返回一条对比用例的所有结构错误（空列表 = 合法）。"""
    errors: list[str] = []
    cid = raw.get("id") or "<no-id>"

    for f in _COMPARISON_REQUIRED:
        if not raw.get(f):
            errors.append(f"[{cid}] 缺必填字段 {f!r}")

    archetype = raw.get("archetype")
    if archetype is not None and archetype not in _ARCHETYPES:
        errors.append(f"[{cid}] archetype={archetype!r} 非法（须属 {sorted(_ARCHETYPES)}）")

    arms = raw.get("arms", ["single", "team"])
    if not isinstance(arms, list) or len(arms) < 2:
        errors.append(f"[{cid}] arms 须为含 ≥2 个臂的列表")
        arms = []
    else:
        for a in arms:
            if a not in _ARMS:
                errors.append(f"[{cid}] arms 含非法臂 {a!r}（须属 {sorted(_ARMS)}）")

    baseline = raw.get("baseline_arm", "single")
    if arms and baseline not in arms:
        errors.append(f"[{cid}] baseline_arm={baseline!r} 不在 arms={arms}")

    toolset = raw.get("toolset", "ceo")
    if toolset not in _TOOLSETS:
        errors.append(f"[{cid}] toolset={toolset!r} 非法（须属 {sorted(_TOOLSETS)}）")

    checks = raw.get("checks", {})
    if not isinstance(checks, dict):
        errors.append(f"[{cid}] checks 须为 {{arm: [check]}} 对象")
        checks = {}
    else:
        for arm, specs in checks.items():
            if arms and arm not in arms:
                errors.append(f"[{cid}] checks 含未声明的臂 {arm!r}")
            if not isinstance(specs, list):
                errors.append(f"[{cid}] checks[{arm!r}] 须为列表")
                continue
            for i, spec in enumerate(specs):
                if not isinstance(spec, dict) or "name" not in spec:
                    errors.append(f"[{cid}] checks[{arm!r}][{i}] 须为含 name 的对象")
                elif spec["name"] not in CHECK_NAMES:
                    errors.append(f"[{cid}] checks[{arm!r}][{i}].name={spec['name']!r} 未注册")

    has_any_check = isinstance(checks, dict) and any(checks.values())
    if not has_any_check and not raw.get("rubric"):
        errors.append(f"[{cid}] 既无 checks 也无 rubric——该用例不会判定任何东西")

    try:
        samples = int(raw.get("samples", 1))
        if samples < 1:
            errors.append(f"[{cid}] samples={samples} 须 ≥1")
    except (TypeError, ValueError):
        errors.append(f"[{cid}] samples 须为整数")

    return errors


def lint_comparison_suite(cases: list[dict[str, Any]]) -> list[str]:
    """校验整套对比用例：逐例结构 + 全局 id 唯一。"""
    errors: list[str] = []
    seen: set[str] = set()
    for raw in cases:
        errors.extend(lint_comparison_case(raw))
        cid = raw.get("id")
        if cid:
            if cid in seen:
                errors.append(f"[{cid}] id 重复")
            seen.add(cid)
    return errors
