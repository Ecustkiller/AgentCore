"""质询作答 → 逐条 Q↔A 解析（质询回合 P1）。

主路径：辩手输出结构化 JSON 数组，按 ``question_index`` 直接构造 ``exchanges[]``。
降级：JSON 解析失败时回退到启发式 blob 拆分（``build_cross_exam_exchanges``）。
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.debate.types import CrossExamQa

logger = get_logger(__name__)

_SECTION_RE = re.compile(
    r"(?:^|\n)\s*(?:"
    r"质询[一二三四五六七八九十\d]+|"
    r"[Qq]\s*\d+|"
    r"\d+[.、)]"
    r")\s*[:：.]?\s*",
    re.MULTILINE,
)

_JSON_ARRAY_FENCE_RE = re.compile(r"```(?:json)?\s*(\[.*?\])\s*```", re.DOTALL)


def parse_cross_exam_response(
    questions: Sequence[str],
    content: str,
    *,
    overall_ok: bool = True,
) -> list[CrossExamQa]:
    """从辩手质询作答构造与 ``questions`` 等长的逐条交换。

    优先解析结构化 JSON 数组；失败时降级为启发式 blob 拆分。
    """
    qs = [q.strip() for q in questions if q and q.strip()]
    if not qs:
        return []

    items = _extract_json_array(content)
    if items is not None:
        return _exchanges_from_json_items(qs, items)

    logger.info(
        "debate.cross_exam_parse.fallback",
        question_count=len(qs),
        content_len=len((content or "").strip()),
    )
    return build_cross_exam_exchanges(qs, content, overall_ok=overall_ok)


def _extract_json_array(content: str) -> list[Any] | None:
    text = (content or "").strip()
    if not text:
        return None

    fence = _JSON_ARRAY_FENCE_RE.search(text)
    if fence:
        text = fence.group(1).strip()
    else:
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end <= start:
            return None
        text = text[start : end + 1]

    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, list) or not data:
        return None
    return data


def _exchanges_from_json_items(
    questions: Sequence[str],
    items: Sequence[Any],
) -> list[CrossExamQa]:
    """把 JSON 数组项映射到与 ``questions`` 对齐的 ``CrossExamQa`` 列表。"""
    out = [CrossExamQa(question=q, answer="", ok=False) for q in questions]
    for pos, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        idx = _resolve_question_index(raw.get("question_index"), pos)
        if idx is None or idx < 0 or idx >= len(out):
            continue
        answer = _as_answer_text(raw.get("answer"))
        ok = _resolve_directly_addressed(raw, answer)
        out[idx] = CrossExamQa(question=questions[idx], answer=answer, ok=ok)
    return out


def _resolve_question_index(value: Any, position: int) -> int | None:
    """``question_index`` 为 1-based；缺省时按数组顺序（0-based position）。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value - 1 if value >= 1 else value
    if isinstance(value, float) and value == int(value):
        n = int(value)
        return n - 1 if n >= 1 else n
    if isinstance(value, str) and value.strip().isdigit():
        n = int(value.strip())
        return n - 1 if n >= 1 else n
    return position


def _as_answer_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def _resolve_directly_addressed(item: dict[str, Any], answer: str) -> bool:
    for key in ("directly_addressed", "ok"):
        val = item.get(key)
        if isinstance(val, bool):
            return val
    return bool(answer.strip())


def build_cross_exam_exchanges(
    questions: Sequence[str],
    answer: str,
    *,
    overall_ok: bool = True,
) -> list[CrossExamQa]:
    """把辩手一次性产出的作答全文拆成与 ``questions`` 等长的逐条交换（启发式降级）。

    优先按「质询一/质询二」「Q1/Q2」「1.」等标题切段；切不出时把全文归第一条、其余留空，
    并按 ``overall_ok`` 与是否有实质内容启发式标 ``ok``。
    """
    qs = [q.strip() for q in questions if q and q.strip()]
    if not qs:
        return []
    text = answer.strip()
    if not text:
        return [CrossExamQa(question=q, answer="", ok=False) for q in qs]

    sections = _split_sections(text)
    if len(sections) == len(qs):
        return [
            CrossExamQa(question=q, answer=sec, ok=_qa_ok(sec, overall_ok))
            for q, sec in zip(qs, sections, strict=True)
        ]
    if len(sections) > 1:
        # 段数与题数不一致：按题数均分或截断，避免丢内容。
        if len(sections) > len(qs):
            sections = sections[: len(qs)]
        else:
            sections = sections + [""] * (len(qs) - len(sections))
        return [
            CrossExamQa(question=q, answer=sec, ok=_qa_ok(sec, overall_ok))
            for q, sec in zip(qs, sections, strict=True)
        ]

    # 无法切段：全文挂第一条，其余空（常见「作答：…；…」连写）。
    if len(qs) == 1:
        return [CrossExamQa(question=qs[0], answer=text, ok=_qa_ok(text, overall_ok))]
    out: list[CrossExamQa] = []
    parts = _split_by_semicolon_chunks(text, len(qs))
    for i, q in enumerate(qs):
        sec = parts[i] if i < len(parts) else ""
        out.append(CrossExamQa(question=q, answer=sec, ok=_qa_ok(sec, overall_ok)))
    return out


def _split_sections(text: str) -> list[str]:
    matches = list(_SECTION_RE.finditer(text))
    if len(matches) < 2:
        return []
    sections: list[str] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()
        if chunk:
            sections.append(chunk)
    return sections


def _split_by_semicolon_chunks(text: str, n: int) -> list[str]:
    """按分号/句号粗切成 n 段（过渡启发式）。"""
    raw = re.split(r"[；;]\s*", text)
    chunks = [c.strip() for c in raw if c.strip()]
    if len(chunks) >= n:
        return chunks[:n]
    if len(chunks) == 1 and n > 1:
        return [chunks[0]] + [""] * (n - 1)
    return chunks + [""] * (n - len(chunks))


def _qa_ok(answer: str, overall_ok: bool) -> bool:
    if not answer.strip():
        return False
    return overall_ok
