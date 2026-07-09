"""Unit tests for conversation tag parsing."""

from agentcore.memory.conversation_tag import parse_conversation_tag


def test_parse_tag_accepts_enum_values():
    assert parse_conversation_tag("code_review") == "code_review"
    assert parse_conversation_tag("RESEARCH") == "research"


def test_parse_tag_accepts_chinese_labels():
    assert parse_conversation_tag("代码审查") == "code_review"
    assert parse_conversation_tag("写作") == "writing"


def test_parse_tag_rejects_unknown():
    assert parse_conversation_tag("闲聊") is None
    assert parse_conversation_tag("") is None
    assert parse_conversation_tag(None) is None
