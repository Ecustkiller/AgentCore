"""Intake — Worker 接到任务后的轻量计划头（启发式，可替换为 LLM）。

Phase 1 用确定性启发式，保证可测、零额外 LLM 成本；后续可换成窄任务推理，
只要仍产出 :class:`IntakeResult` 即可。
"""

from __future__ import annotations

import re

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.runtime.routing.models import Complexity, ExecutionStrategy, IntakeResult

logger = get_logger(__name__)


def resolve_worker_token_ceiling(intake_budget: int) -> int:
    """Loose cumulative-token backstop for a worker run.

    ``clamp(intake_budget × factor, floor, cap)`` — a generous safety valve, not a
    tight leash: compaction (``engine/tool_clear.py``) does the heavy lifting on the
    window, this only stops a runaway from blowing far past its estimate (the
    2221→41378 pathology). The Intake budget is a coarse heuristic (4k/16k/48k), so
    it is *widened* by ``factor`` before it ever gates a round — a research-heavy
    worker should not be guillotined at its raw estimate.

    Returns ``0`` (disabled — no ceiling) when the feature is switched off or there
    is no estimate to widen; ``react_loop`` treats ``0`` as "no token backstop", so
    CEO / solo paths (which never pass a budget) are unaffected.
    """
    factor = settings.engine_worker_token_budget_factor
    cap = settings.engine_worker_token_budget_cap
    floor = settings.engine_worker_token_budget_floor
    if factor <= 0 or cap <= 0 or intake_budget <= 0:
        return 0
    ceiling = int(intake_budget * factor)
    ceiling = max(ceiling, floor)
    return min(ceiling, cap)

# Token 预算粗估（按复杂度档；非精确计费，仅治理参考）
_BUDGET: dict[Complexity, int] = {
    Complexity.SIMPLE: 4_000,
    Complexity.MODERATE: 16_000,
    Complexity.COMPLEX: 48_000,
}

_RESEARCH_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"调研|研究|检索|搜索|查资料|竞品|文献|survey|research|investigate|look\s*up",
        r"web_search|联网|最新消息|新闻",
    )
)

_TOOL_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"写(入|文件|代码)|改(文件|代码)|实现|修复|重构|跑测试|执行|落盘",
        r"file_write|str_replace|code_execute|file_list|file_read",
        r"implement|refactor|fix|patch|edit|write\s+(a\s+)?file|run\s+tests?",
    )
)

_COMPLEX_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"架构|多模块|端到端|迁移|拆分|设计方案|接口契约|跨服务",
        r"architecture|multi[- ]?module|end[- ]to[- ]end|migrat|redesign|contract",
        r"并且|同时|以及|以及还要|分步|阶段|依赖",
    )
)

_SIMPLE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"^(改|修|补|更新|翻译|总结|润色|解释|回答)",
        r"\b(typo|rename|one[- ]liner|简单|一句话|简短)\b",
    )
)


def assess_intake(
    *,
    task: str,
    role: str = "",
    objective: str = "",
    tools: list[str] | None = None,
) -> IntakeResult:
    """对 Worker 任务做轻量复杂度 / 策略评估。

    ``tools`` 为该 Worker 的工具 allow-list（``None`` = 无限制）。启发式只读文本与
    工具名，不调用 LLM。
    """
    blob = "\n".join(p for p in (role, objective, task) if p).strip()
    signals: list[str] = []

    research_hit = _any_match(_RESEARCH_PATTERNS, blob)
    tool_hit = _any_match(_TOOL_PATTERNS, blob)
    complex_hit = _any_match(_COMPLEX_PATTERNS, blob)
    simple_hit = _any_match(_SIMPLE_PATTERNS, blob)

    if research_hit:
        signals.append("research_keyword")
    if tool_hit:
        signals.append("tool_keyword")
    if complex_hit:
        signals.append("complex_keyword")
    if simple_hit:
        signals.append("simple_keyword")

    tool_names = {t.lower() for t in (tools or [])}
    if any(n in tool_names for n in ("web_search", "read_url")):
        signals.append("research_tool_granted")
        research_hit = True
    if any(
        n in tool_names
        for n in ("file_write", "str_replace", "code_execute", "file_read", "file_list")
    ):
        signals.append("mutation_tool_granted")
        tool_hit = True

    # 长任务抬升复杂度
    task_len = len(task or "")
    if task_len > 800:
        signals.append("long_task")
        complex_hit = True
    elif task_len > 280 and not simple_hit:
        signals.append("medium_task")

    if research_hit:
        strategy = ExecutionStrategy.NEEDS_RESEARCH
    elif tool_hit or (tools is not None and len(tools) > 0):
        strategy = ExecutionStrategy.NEEDS_TOOLS
    else:
        strategy = ExecutionStrategy.DIRECT_EXECUTE

    if complex_hit or (research_hit and tool_hit):
        complexity = Complexity.COMPLEX
    elif research_hit or tool_hit or "medium_task" in signals:
        complexity = Complexity.MODERATE
    elif simple_hit and task_len < 200:
        complexity = Complexity.SIMPLE
    else:
        # 默认偏保守：未知任务按 moderate，避免低估预算
        complexity = Complexity.MODERATE if task_len >= 80 else Complexity.SIMPLE
        if complexity is Complexity.MODERATE:
            signals.append("default_moderate")
        else:
            signals.append("default_simple")

    budget = _BUDGET[complexity]
    if strategy is ExecutionStrategy.NEEDS_RESEARCH:
        budget = int(budget * 1.25)
    elif strategy is ExecutionStrategy.DIRECT_EXECUTE and complexity is Complexity.SIMPLE:
        budget = min(budget, _BUDGET[Complexity.SIMPLE])

    rationale = _rationale(complexity, strategy, signals)
    result = IntakeResult(
        complexity=complexity,
        strategy=strategy,
        token_budget=budget,
        rationale=rationale,
        signals=signals,
    )
    logger.info(
        "routing.intake",
        complexity=complexity.value,
        strategy=strategy.value,
        token_budget=budget,
        signals=signals,
        task_chars=task_len,
    )
    return result


def _any_match(patterns: tuple[re.Pattern[str], ...], text: str) -> bool:
    return any(p.search(text) for p in patterns)


def _rationale(
    complexity: Complexity,
    strategy: ExecutionStrategy,
    signals: list[str],
) -> str:
    sig = ",".join(signals) if signals else "none"
    return f"{complexity.value}/{strategy.value} via [{sig}]"
