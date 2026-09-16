"""Unit tests for Cursor-shaped conversation search terms."""

from agentcore.core.search_query import (
    earliest_term_in_text,
    parse_conversation_search_terms,
)


def test_parse_empty_and_whitespace():
    assert parse_conversation_search_terms("") == []
    assert parse_conversation_search_terms("   ") == []
    assert parse_conversation_search_terms('""') == []
    assert parse_conversation_search_terms('"   "') == []


def test_parse_unquoted_and():
    assert parse_conversation_search_terms("oauth 登录") == ["oauth", "登录"]
    assert parse_conversation_search_terms("白板") == ["白板"]


def test_parse_quoted_phrase():
    assert parse_conversation_search_terms('"oauth 登录"') == ["oauth 登录"]
    assert parse_conversation_search_terms("「白板软件」") == ["白板软件"]
    assert parse_conversation_search_terms("foo \"bar baz\" qux") == [
        "foo",
        "bar baz",
        "qux",
    ]


def test_parse_unbalanced_quote_stays_literal():
    assert parse_conversation_search_terms('"foo') == ['"foo']


def test_earliest_term_in_text():
    assert earliest_term_in_text("讨论 oauth 与登录", ["登录", "oauth"]) == "oauth"
    assert earliest_term_in_text("hello", ["oauth"]) is None
