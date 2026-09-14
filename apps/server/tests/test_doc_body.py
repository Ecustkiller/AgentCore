from agentcore.doc.body import MAX_MARKDOWN_CHARS, empty_body, sanitize_body


def test_empty_body_shape():
    assert empty_body() == {"markdown": ""}


def test_sanitize_keeps_markdown_and_clips():
    body = sanitize_body({"markdown": "# 结论\n\n可以发"})
    assert body == {"markdown": "# 结论\n\n可以发"}
    long = "x" * (MAX_MARKDOWN_CHARS + 50)
    clipped = sanitize_body({"markdown": long})
    assert len(clipped["markdown"]) == MAX_MARKDOWN_CHARS
    assert sanitize_body("# 直接字符串") == {"markdown": "# 直接字符串"}


def test_sanitize_drops_nul_and_garbage():
    assert sanitize_body({"markdown": "a\x00b"}) == {"markdown": "ab"}
    assert sanitize_body(None) == {"markdown": ""}
    assert sanitize_body([]) == {"markdown": ""}
    assert sanitize_body({"markdown": 3}) == {"markdown": ""}
    assert sanitize_body({"markdown": None}) == {"markdown": ""}


def test_sanitize_ignores_legacy_block_payload():
    body = sanitize_body(
        {
            "schemaVersion": 1,
            "blocks": [
                {"type": "paragraph", "text": "旧稿"},
                {"type": "table", "columns": ["A"], "rows": [["1"]]},
            ],
        }
    )
    assert body == {"markdown": ""}
