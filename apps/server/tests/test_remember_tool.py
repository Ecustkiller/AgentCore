"""CEO remember tool — records an explicit user directive as a USER RULE (§5.7 分流).

DB-free here: the schema contract + the pure mutate helpers. The end-to-end write (directive →
``role='rule', ai_maintained=false`` document, immediate injection) is exercised against a real
schema in ``tests/integration/test_documents.py``.
"""

from agentcore.memory.rules_injection import (
    append_user_rule_bullet,
    mutate_user_rule_markdown,
)
from agentcore.tools.builtin.remember import RememberTool, build_remember_tool


def test_remember_schema_is_static():
    tool = RememberTool(folder_id=None)
    assert tool.schema.name == "remember"
    # Steers the model to the split: explicit directive here, inferred preferences to巩固.
    assert "明确" in tool.schema.description
    assert tool.schema.parameters["required"] == []
    assert tool.schema.parameters["properties"]["scope"]["enum"] == ["global", "project"]
    assert tool.schema.parameters["properties"]["action"]["enum"] == [
        "add",
        "replace",
        "forget",
        "list",
    ]
    assert "replaces" in tool.schema.parameters["properties"]


def test_build_remember_tool_defaults():
    tool = build_remember_tool(folder_id="fold-1")
    assert isinstance(tool, RememberTool)
    assert tool.folder_id == "fold-1"


def test_append_user_rule_bullet_adds_and_dedupes():
    md, changed = append_user_rule_bullet("", "以后都用中文回复")
    assert changed is True
    assert md == "- 以后都用中文回复\n"

    # A normalized duplicate (whitespace-only difference) is a no-op — re-remembering never grows.
    md2, changed2 = append_user_rule_bullet(md, "以后都用中文回复  ")
    assert changed2 is False
    assert md2 == md

    # A genuinely new rule appends as another bullet.
    md3, changed3 = append_user_rule_bullet(md, "别用表格")
    assert changed3 is True
    assert md3 == "- 以后都用中文回复\n- 别用表格\n"


def test_append_user_rule_bullet_ignores_blank():
    assert append_user_rule_bullet("- x\n", "   ") == ("- x\n", False)


def test_mutate_add_default_and_dedupe():
    added = mutate_user_rule_markdown("", action="add", content="用中文")
    assert added.changed is True
    assert "已追加" in added.message
    assert added.markdown == "- 用中文\n"

    # Missing action defaults to add.
    again = mutate_user_rule_markdown(added.markdown, content="用中文")
    assert again.action == "add"
    assert again.changed is False
    assert "已经记过了" in again.message


def test_mutate_replace_removes_old_then_writes():
    base = "- 用英文\n- 别用表格\n"
    result = mutate_user_rule_markdown(
        base, action="replace", content="用中文", replaces="用英文"
    )
    assert result.changed is True
    assert "已替换" in result.message
    assert "用英文" in result.message
    assert result.markdown == "- 别用表格\n- 用中文\n"
    assert result.removed == ("用英文",)


def test_mutate_replace_missing_old_appends_honestly():
    base = "- 别用表格\n"
    result = mutate_user_rule_markdown(
        base, action="replace", content="用中文", replaces="用英文"
    )
    assert result.changed is True
    assert "未找到旧条" in result.message
    assert "已追加" in result.message
    assert "已替换" not in result.message
    assert result.markdown == "- 别用表格\n- 用中文\n"


def test_mutate_replace_missing_old_and_new_exists():
    base = "- 用中文\n"
    result = mutate_user_rule_markdown(
        base, action="replace", content="用中文", replaces="用英文"
    )
    assert result.changed is False
    assert "未找到旧条" in result.message
    assert "已存在" in result.message


def test_mutate_forget_deletes_all_same_key():
    # Same normalized key via leading/trailing whitespace on the bullet text.
    base = "- 用中文\n- 别用表格\n-   用中文   \n"
    result = mutate_user_rule_markdown(base, action="forget", content="用中文")
    assert result.changed is True
    assert "已删除" in result.message
    assert result.markdown == "- 别用表格\n"
    assert len(result.removed) == 2


def test_mutate_forget_casefold_latin():
    base = "- Prefer English replies\n- 别用表格\n- prefer   english replies\n"
    result = mutate_user_rule_markdown(
        base, action="forget", content="PREFER ENGLISH REPLIES"
    )
    assert result.changed is True
    assert result.markdown == "- 别用表格\n"
    assert len(result.removed) == 2


def test_mutate_forget_not_found():
    result = mutate_user_rule_markdown("- x\n", action="forget", content="不存在的规则")
    assert result.changed is False
    assert "未找到" in result.message
    assert result.markdown == "- x\n"


def test_mutate_list_returns_body_without_claiming_write():
    empty = mutate_user_rule_markdown("", action="list")
    assert empty.changed is False
    assert "暂无" in empty.message
    assert empty.rules_markdown == ""

    listed = mutate_user_rule_markdown("- 用中文\n", action="list")
    assert listed.changed is False
    assert "用中文" in listed.message
    assert listed.rules_markdown == "- 用中文\n"
