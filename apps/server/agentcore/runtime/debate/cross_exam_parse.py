"""质询作答 → 逐条 Q↔A 解析（质询回合 P1）。

主路径：按 markdown 标题确定性切段（``### 质询一`` / ``质询1`` / ``Q1`` / ``1.``），
构造 ``exchanges[]``。切不出段时优雅降级：整段挂第一题、其余空答。首个标题前的引子
确定性丢弃。JSON 解析路径已退役（辩论发言是给人看的流式文本，与立论同用标题体）。

是否正面回应 / 回避由裁判据 Q↔A 原文裁定（engagement + decisive），本模块只负责问↔答对齐，
不产出任何二元褒贬字段。
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from agentcore.core.logging import get_logger
from agentcore.runtime.debate.types import CrossExamQa

logger = get_logger(__name__)

# 数字分段要求分隔符后非数字，避免「3.5 倍…」被误当第 3 段。
# 可选 ``### `` 等 markdown 标题前缀（产出端契约：``### 质询一``）。
_SECTION_RE = re.compile(
    r"(?:^|\n)\s*(?:#{1,6}\s*)?(?:"
    r"质询[一二三四五六七八九十\d]+|"
    r"[Qq]\s*\d+|"
    r"\d+[.、)](?!\d)"
    r")\s*[:：.]?\s*",
    re.MULTILINE,
)


def parse_cross_exam_response(
    questions: Sequence[str],
    content: str,
    *,
    side_key: str = "",
) -> list[CrossExamQa]:
    """从辩手质询作答构造与 ``questions`` 等长的逐条交换。

    主路径：标题切段；切不出 → 整段挂第一题。只对齐 question ↔ answer；
    空答表示未作答 / 降级兜底。``side_key`` 写入降级日志，便于定位是哪一方。
    """
    qs = [q.strip() for q in questions if q and q.strip()]
    if not qs:
        return []

    text = (content or "").strip()
    if not text:
        return [CrossExamQa(question=q, answer="") for q in qs]

    sections = _split_sections(text)
    if sections:
        if len(sections) > len(qs):
            sections = sections[: len(qs)]
        elif len(sections) < len(qs):
            sections = sections + [""] * (len(qs) - len(sections))
        return [
            CrossExamQa(question=q, answer=sec)
            for q, sec in zip(qs, sections, strict=True)
        ]

    logger.info(
        "debate.cross_exam_parse.degraded",
        side_key=side_key or None,
        question_count=len(qs),
        content_len=len(text),
    )
    # 切不出段：全文挂第一条，其余空。
    if len(qs) == 1:
        return [CrossExamQa(question=qs[0], answer=text)]
    return [CrossExamQa(question=qs[0], answer=text)] + [
        CrossExamQa(question=q, answer="") for q in qs[1:]
    ]


def build_cross_exam_exchanges(
    questions: Sequence[str],
    answer: str,
    *,
    side_key: str = "",
) -> list[CrossExamQa]:
    """与 :func:`parse_cross_exam_response` 同契约（兼容既有调用点）。"""
    return parse_cross_exam_response(questions, answer, side_key=side_key)


def _split_sections(text: str) -> list[str]:
    """按质询标题切段；首个标题前的引子丢弃。无标题 → 空列表（触发挂第一题降级）。"""
    matches = list(_SECTION_RE.finditer(text))
    if not matches:
        return []
    sections: list[str] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append(text[start:end].strip())
    return sections
