"""Contract gate: mechanical quality checks on a worker run's output (阶段2).

A worker's product is accepted only if it satisfies its node's delivery contract
(:class:`RunContract`). 阶段2 第一刀只做「机械校验」——看产出的*形*而非*质*：非空（系统
兜底，始终生效）、最短/最长长度、必含关键词、必备小标题、以及（声明
``output_format="json"`` 时）能否解析为 JSON。判「写得好不好」的语义裁判（额外一次 LLM
调用）留作后续增强。

校验的后续处置（带反馈返工 / 按 ``strict`` 决定硬退或软提醒）在执行器里，本模块只产出结论
（:class:`ContractVerdict`）、给模型的修正说明与产出要求描述，保持纯函数、可独立单测。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from agentcore.runtime.runs.types import RunContract


@dataclass
class ContractVerdict:
    """Outcome of checking one output against its contract."""

    ok: bool
    failures: list[str] = field(default_factory=list)


def check_contract(content: str, contract: RunContract | None) -> ContractVerdict:
    """Check ``content`` against ``contract``; return a verdict + human reasons.

    The non-empty baseline always applies — an empty product is never acceptable,
    even with no contract (系统兜底，对应决策②). When a contract is given, its
    mechanical rules layer on top. Failure order is stable so feedback reads
    predictably.
    """
    text = content.strip()
    if not text:
        return ContractVerdict(ok=False, failures=["产出为空"])
    if contract is None:
        return ContractVerdict(ok=True)

    failures: list[str] = []
    length = len(text)
    if contract.min_length and length < contract.min_length:
        failures.append(f"产出 {length} 字，少于要求的 {contract.min_length} 字")
    if contract.max_length and length > contract.max_length:
        failures.append(f"产出 {length} 字，超过上限 {contract.max_length} 字")
    for keyword in contract.must_contain:
        if keyword and keyword not in content:
            failures.append(f"缺少必须包含的内容：{keyword}")
    for section in contract.required_sections:
        if section and not _has_section(content, section):
            failures.append(f"缺少必备章节：{section}")
    if contract.output_format == "json" and not _is_json(content):
        failures.append("产出不是可解析的 JSON")
    return ContractVerdict(ok=not failures, failures=failures)


def format_feedback(verdict: ContractVerdict) -> str:
    """Render a verdict's failures as a correction instruction for the retry."""
    if verdict.ok or not verdict.failures:
        return ""
    items = "\n".join(f"- {f}" for f in verdict.failures)
    return f"你上一次的产出未达到以下要求，请逐条修正后输出完整的最终结果：\n{items}"


def describe_contract(contract: RunContract | None) -> str:
    """Render a contract as up-front requirements stated in the worker's prompt."""
    if contract is None:
        return ""
    lines: list[str] = []
    if contract.required_sections:
        lines.append("- 必须包含这些章节（用小标题）：" + "、".join(contract.required_sections))
    if contract.must_contain:
        lines.append("- 必须涉及：" + "、".join(contract.must_contain))
    if contract.min_length:
        lines.append(f"- 篇幅不少于 {contract.min_length} 字")
    if contract.max_length:
        lines.append(f"- 篇幅不超过 {contract.max_length} 字")
    if contract.output_format == "json":
        lines.append("- 产出必须是可解析的 JSON")
    return "\n".join(lines)


def _has_section(content: str, section: str) -> bool:
    """Whether ``content`` carries ``section`` as a heading-like line.

    Accepts a markdown heading (``# 结论``), a bold line (``**结论**``), or a
    labelled line (``结论：…``) — the shapes a model actually uses for a section —
    rather than any incidental mention, so the check means structure not keyword.
    """
    target = section.strip().casefold()
    if not target:
        return True
    for raw in content.splitlines():
        line = raw.strip()
        low = line.casefold()
        if line.startswith("#") and target in low:
            return True
        if line.startswith("**") and line.endswith("**") and target in low:
            return True
        if low.startswith(target) and low[len(target) :].lstrip()[:1] in ("：", ":"):
            return True
    return False


def _is_json(content: str) -> bool:
    """Whether ``content`` (optionally inside a ```json fence) parses as JSON."""
    try:
        json.loads(_strip_code_fence(content.strip()))
    except (ValueError, TypeError):
        return False
    return True


def _strip_code_fence(text: str) -> str:
    """Drop a surrounding ``` / ```json fence if present, else return as-is."""
    if not text.startswith("```"):
        return text
    body = text[3:]
    newline = body.find("\n")
    if newline != -1 and body[:newline].strip().casefold() in ("", "json"):
        body = body[newline + 1 :]
    if body.rstrip().endswith("```"):
        body = body.rstrip()[:-3]
    return body.strip()
