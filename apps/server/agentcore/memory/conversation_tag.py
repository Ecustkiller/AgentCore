"""Conversation auto-tag enum (对话自动标签, 前端UX设计 §十五).

Four fixed categories, stored as constrained strings — not free text.
"""

from enum import StrEnum

# Re-exported for OpenAPI / schema validation.
CONVERSATION_TAG_VALUES: frozenset[str] = frozenset(
    {"code_review", "research", "writing", "analysis"}
)


class ConversationTag(StrEnum):
    CODE_REVIEW = "code_review"
    RESEARCH = "research"
    WRITING = "writing"
    ANALYSIS = "analysis"


TAG_LABELS: dict[ConversationTag, str] = {
    ConversationTag.CODE_REVIEW: "代码审查",
    ConversationTag.RESEARCH: "研究",
    ConversationTag.WRITING: "写作",
    ConversationTag.ANALYSIS: "分析",
}

# Chinese labels and common aliases the title model may emit.
_TAG_ALIASES: dict[str, str] = {
    **{tag.value: tag.value for tag in ConversationTag},
    **{label: tag.value for tag, label in TAG_LABELS.items()},
    "代码审核": ConversationTag.CODE_REVIEW.value,
    "审查": ConversationTag.CODE_REVIEW.value,
    "code review": ConversationTag.CODE_REVIEW.value,
    "code_review": ConversationTag.CODE_REVIEW.value,
    "research": ConversationTag.RESEARCH.value,
    "研究": ConversationTag.RESEARCH.value,
    "writing": ConversationTag.WRITING.value,
    "写作": ConversationTag.WRITING.value,
    "analysis": ConversationTag.ANALYSIS.value,
    "分析": ConversationTag.ANALYSIS.value,
}


def parse_conversation_tag(raw: str | None) -> str | None:
    """Normalize a model-supplied tag; unknown values are discarded (→ null)."""
    if not raw or not (text := raw.strip()):
        return None
    key = text.lower()
    if key in _TAG_ALIASES:
        return _TAG_ALIASES[key]
    # Allow exact Chinese label match (case-sensitive for CJK).
    if text in _TAG_ALIASES:
        return _TAG_ALIASES[text]
    return None
