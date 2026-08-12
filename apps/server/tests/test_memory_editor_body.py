"""Legacy memory editor: body-only reads + frontmatter-preserving body writes."""

from agentcore.db.repositories.documents import (
    _memory_note_body_for_write,
    _replace_body_keeping_frontmatter,
)
from agentcore.documents.frontmatter import FrontmatterError, parse_entry_frontmatter
from agentcore.memory.document_store import memory_editor_body


def test_memory_editor_body_strips_well_formed_frontmatter():
    raw = "---\napply: always\ndescription: 摘要\n---\n## 沟通偏好\n- 用中文\n"
    assert memory_editor_body(raw) == "## 沟通偏好\n- 用中文\n"


def test_memory_editor_body_passthrough_without_frontmatter():
    assert memory_editor_body("plain\n") == "plain\n"
    assert memory_editor_body("") == ""


def test_memory_editor_body_unclosed_returns_raw():
    raw = "---\napply: always\nno close"
    assert memory_editor_body(raw) == raw


def test_replace_body_keeps_opaque_frontmatter_block():
    existing = (
        "---\n"
        "apply: always\n"
        "# keep-me\n"
        "description: 旧摘要\n"
        "globs: ignored\n"
        "---\n"
        "old body\n"
    )
    out = _replace_body_keeping_frontmatter(existing, "new body\n")
    assert out is not None
    assert out.startswith(
        "---\napply: always\n# keep-me\ndescription: 旧摘要\nglobs: ignored\n---\n"
    )
    assert out.endswith("new body\n")
    parsed = parse_entry_frontmatter(out)
    assert not isinstance(parsed, FrontmatterError)
    assert parsed.description == "旧摘要"
    assert parsed.body == "new body\n"


def test_memory_note_body_for_write_preserves_description_on_body_only_update():
    existing = "---\napply: always\ndescription: 用户偏好\n---\nold\n"
    out = _memory_note_body_for_write(
        "## 沟通偏好\n- 用中文\n",
        existing=existing,
        apply_mode="always",
    )
    parsed = parse_entry_frontmatter(out)
    assert not isinstance(parsed, FrontmatterError)
    assert parsed.apply == "always"
    assert parsed.description == "用户偏好"
    assert parsed.body == "## 沟通偏好\n- 用中文\n"


def test_memory_note_body_for_write_seeds_apply_on_create():
    out = _memory_note_body_for_write(
        "## 沟通偏好\n- 用中文\n",
        existing=None,
        apply_mode="always",
    )
    parsed = parse_entry_frontmatter(out)
    assert not isinstance(parsed, FrontmatterError)
    assert parsed.has_frontmatter is True
    assert parsed.apply == "always"
    assert parsed.description == ""
    assert parsed.body == "## 沟通偏好\n- 用中文\n"


def test_memory_note_body_for_write_incoming_frontmatter_is_authoritative():
    existing = "---\napply: always\ndescription: 旧\n---\nold\n"
    incoming = "---\napply: on_demand\ndescription: 新\n---\nnew\n"
    out = _memory_note_body_for_write(
        incoming, existing=existing, apply_mode="always"
    )
    parsed = parse_entry_frontmatter(out)
    assert not isinstance(parsed, FrontmatterError)
    assert parsed.apply == "on_demand"
    assert parsed.description == "新"
    assert parsed.body == "new\n"
