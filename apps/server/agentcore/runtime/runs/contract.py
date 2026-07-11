"""Contract gate: mechanical quality checks on a worker run's output (阶段2).

A worker's product is accepted only if it satisfies its node's delivery spec
(:class:`Deliverable`). 阶段2 第一刀做「机械校验」——看产出的*形*而非*质*：非空（系统
兜底，始终生效）、最短/最长长度、必含关键词、必备小标题、（声明
``output_format="json"`` 时）能否解析为 JSON、以及声明式 ``artifacts`` 路径清单相对
工作区的存在性对账。判「写得好不好」的语义裁判（额外一次 LLM 调用）留作后续增强。

校验的后续处置（带反馈返工 / 按 ``strict`` 决定硬退或软提醒）在执行器里，本模块只产出结论
（:class:`ContractVerdict`）、给模型的修正说明与产出要求描述，保持纯函数、可独立单测。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §八（Run 模型）
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass, field
from typing import Any

from agentcore.runtime.runs.types import Deliverable

# Handoff minimum when the node has downstream dependents (协作模式 handoff 门禁).
MIN_HANDOFF_SUMMARY_CHARS = 50
MIN_HANDOFF_KEY_POINTS = 2


@dataclass
class ContractVerdict:
    """Outcome of checking one output against its contract."""

    ok: bool
    failures: list[str] = field(default_factory=list)


def check_contract(
    content: str,
    deliverable: Deliverable | None,
    *,
    files_written: int = 0,
    debrief: dict[str, Any] | None = None,
    workspace_paths: list[str] | None = None,
) -> ContractVerdict:
    """Check ``content`` against ``deliverable``; return a verdict + human reasons.

    The non-empty baseline always applies — an empty product is never acceptable,
    even with no deliverable (系统兜底，对应决策②). When a deliverable is given, its
    mechanical rules layer on top. Failure order is stable so feedback reads
    predictably.

    ``files_written`` is the count of file-writing tool calls the run made (from
    ``files_touched_from_transcript``); it backs the ``requires_files`` predicate so
    a file deliverable that was only pasted into the reply — never written to the
    workspace — fails and auto-reworks. Stays a pure function (the caller derives the
    count) so it remains trivially unit-testable.

    ``workspace_paths`` is the flat path index used to reconcile ``artifacts``
    patterns (exact / directory prefix / glob). Callers pass the live workspace
    listing unioned with this run's ``files_touched``; ``None`` / empty means the
    workspace looks empty for matching purposes.

    Workers often finish with ``file_write`` + ``handoff`` and no streamed prose
    (``deliverable_only`` rolls back narration before non-terminal tools). The
    baseline therefore also accepts alternate product signals: workspace file writes
    (``files_written > 0``) or a usable ``handoff`` debrief (``debrief`` from
    ``debrief_from_transcript`` — summary / key_points / etc.).
    """
    text = content.strip()
    if not text and files_written <= 0 and debrief is None:
        return ContractVerdict(ok=False, failures=["产出为空"])
    if deliverable is None:
        return ContractVerdict(ok=True)

    failures: list[str] = []
    length = len(text)
    if deliverable.min_length and length < deliverable.min_length:
        failures.append(f"产出 {length} 字，少于要求的 {deliverable.min_length} 字")
    if deliverable.max_length and length > deliverable.max_length:
        failures.append(f"产出 {length} 字，超过上限 {deliverable.max_length} 字")
    if deliverable.must_contain:
        # Case-insensitive, mirroring required_sections' casefold match — the keyword
        # is a content requirement, not a literal-byte check, so casing must not flip
        # the verdict. The failure message still shows the operator's original text.
        haystack = content.casefold()
        for keyword in deliverable.must_contain:
            if keyword and keyword.casefold() not in haystack:
                failures.append(f"缺少必须包含的内容：{keyword}")
    for section in deliverable.required_sections:
        if section and not _has_section(content, section):
            failures.append(f"缺少必备章节：{section}")
    if deliverable.output_format == "json" and not _is_json(content):
        failures.append("产出不是可解析的 JSON")
    if deliverable.requires_files and files_written <= 0:
        failures.append("未把产物写入工作区：交付物须用 file_write 落盘，而非粘在回复正文里")
    if deliverable.artifacts:
        missing = missing_artifacts(deliverable.artifacts, workspace_paths or [])
        if missing:
            listed = "、".join(f"`{p}`" for p in missing)
            failures.append(f"声明的交付物路径未落盘：{listed}")
    return ContractVerdict(ok=not failures, failures=failures)


def missing_artifacts(patterns: list[str], workspace_paths: list[str]) -> list[str]:
    """Return artifact patterns with no match in ``workspace_paths`` (stable order)."""
    return [p for p in patterns if p and not artifact_present(p, workspace_paths)]


def artifact_present(pattern: str, workspace_paths: list[str]) -> bool:
    """Whether ``pattern`` (exact path / directory / glob) hits any workspace path."""
    pat = pattern.replace("\\", "/").strip().lstrip("./")
    if not pat:
        return True
    normalized = [p.replace("\\", "/").lstrip("./") for p in workspace_paths if p]
    if pat.endswith("/"):
        prefix = pat
        bare = pat.rstrip("/")
        return any(p == bare or p.startswith(prefix) for p in normalized)
    if any(ch in pat for ch in "*?["):
        return any(
            fnmatch.fnmatch(p, pat) or fnmatch.fnmatch(p.rsplit("/", 1)[-1], pat)
            for p in normalized
        )
    return any(p == pat or p.endswith("/" + pat) for p in normalized)


def format_feedback(verdict: ContractVerdict) -> str:
    """Render a verdict's failures as a correction instruction for the retry.

    This is the worker's single rework shot, so it's told to spend it on the
    product itself — emit the complete corrected output, no meta-commentary —
    rather than burning the turn on an apology or an explanation.
    """
    if verdict.ok or not verdict.failures:
        return ""
    items = "\n".join(f"- {f}" for f in verdict.failures)
    return (
        f"你上一次的产出未达到以下要求：\n{items}\n"
        "请直接输出修正后的【完整最终产出】（补齐上述差距，其余内容保持原样），"
        "不要解释、不要道歉、不要附带任何说明文字。"
    )


def describe_deliverable(deliverable: Deliverable | None) -> str:
    """Render a deliverable as up-front requirements stated in the worker's prompt."""
    if deliverable is None:
        return ""
    lines: list[str] = []
    if deliverable.name:
        lines.append(f"交付物：{deliverable.name}")
    if deliverable.required_sections:
        lines.append("- 必须包含这些章节（用小标题）：" + "、".join(deliverable.required_sections))
    if deliverable.must_contain:
        lines.append("- 必须涉及：" + "、".join(deliverable.must_contain))
    if deliverable.min_length:
        lines.append(f"- 篇幅不少于 {deliverable.min_length} 字")
    if deliverable.max_length:
        lines.append(f"- 篇幅不超过 {deliverable.max_length} 字")
    if deliverable.output_format == "json":
        lines.append("- 产出必须是可解析的 JSON")
    if deliverable.artifacts:
        listed = "、".join(f"`{p}`" for p in deliverable.artifacts)
        lines.append(f"- 必须把以下交付物路径写入工作区（可用目录或通配）：{listed}")
    elif deliverable.requires_files:
        lines.append(
            "- 必须调用 file_write 把产物写进工作区（成品是落盘文件，不能只贴在回复正文里）"
        )
    return "\n".join(lines)


def debrief_meets_minimum(debrief: dict[str, Any] | None) -> bool:
    """True when a handoff brief meets the downstream-gate information floor."""
    if not debrief:
        return False
    summary = str(debrief.get("summary") or "").strip()
    if len(summary) >= MIN_HANDOFF_SUMMARY_CHARS:
        return True
    raw_points = debrief.get("key_points") or []
    if isinstance(raw_points, str):
        raw_points = [raw_points]
    points = [str(p).strip() for p in raw_points if str(p).strip()]
    return len(points) >= MIN_HANDOFF_KEY_POINTS


def format_handoff_feedback(*, present_but_thin: bool = False) -> str:
    """Correction instruction that forces one handoff (or a richer one) for downstream."""
    if present_but_thin:
        return (
            "你提交的 handoff 交接简报信息量不足（下游队员要靠它接手）。"
            f"请重新调用 handoff：summary 至少 {MIN_HANDOFF_SUMMARY_CHARS} 字，"
            f"或提供不少于 {MIN_HANDOFF_KEY_POINTS} 条具体 key_points"
            "（文件路径 / 关键决定 / 数字，别空泛）。"
            "调用 handoff 即收尾；不要只写正文不交简报。"
        )
    return (
        "你有下游队员依赖本次交接，但尚未调用 handoff。"
        "请在本轮调用 handoff 提交交接简报："
        f"summary 至少 {MIN_HANDOFF_SUMMARY_CHARS} 字，"
        f"或提供不少于 {MIN_HANDOFF_KEY_POINTS} 条具体 key_points"
        "（文件路径 / 关键决定 / 数字）。调用即代表收尾完成。"
    )


def synthesize_debrief(
    content: str,
    files_touched: list[str],
) -> dict[str, Any]:
    """Engine-built degraded debrief when a required handoff is still missing.

    Marked ``degraded=True`` so CEO / downstream know it is a fallback, not author intent.
    """
    parts: list[str] = []
    prose = content.strip()
    if prose:
        parts.append(prose[:200])
    if files_touched:
        parts.append("已落盘：" + "、".join(files_touched[:8]))
    summary = "；".join(parts) or "（引擎降级合成：无正文与落盘记录）"
    key_points = [f"文件：{p}" for p in files_touched[:4]] if files_touched else []
    out: dict[str, Any] = {"summary": summary, "degraded": True}
    if key_points:
        out["key_points"] = key_points
    return out


def node_has_dependents(plan: Any, run_id: str) -> bool:
    """True when any plan node lists ``run_id`` in its ``depends_on``."""
    nodes = getattr(plan, "nodes", None) or []
    return any(run_id in (getattr(n, "depends_on", None) or []) for n in nodes)


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
