"""Tests for memory topic directory assembly (Agent记忆与知识系统 §二)."""

from agentcore.memory.injection import MemoryTopic, load_memory_topics
from agentcore.memory.store import FileMemoryStore
from agentcore.memory.user_memory import topic_summary_line


async def test_memory_topics_merge_global_and_project(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/全局主题.md", "## 要点\n- g\n")
    await store.save("u1", "主题/项目主题.md", "## 要点\n- p\n", scope="F1")
    topics = await load_memory_topics(store, "u1", folder_id="F1", enabled=True)
    # Names merged + sorted, each carrying its note's first-line summary (§1.4).
    assert topics == [MemoryTopic("全局主题", "g"), MemoryTopic("项目主题", "p")]


async def test_memory_topics_dedupe_across_scopes(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/部署.md", "## 要点\n- g\n")
    await store.save("u1", "主题/部署.md", "## 要点\n- p\n", scope="F1")
    topics = await load_memory_topics(store, "u1", folder_id="F1", enabled=True)
    # Same name in both scopes appears once; the GLOBAL summary wins (stable-prefix layer).
    assert topics == [MemoryTopic("部署", "g")]


async def test_memory_topics_empty_when_disabled(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/部署.md", "## 要点\n- g\n")
    assert await load_memory_topics(store, "u1", folder_id=None, enabled=False) == []


async def test_memory_topics_summary_skips_chrome_and_section(tmp_path):
    # The summary is the first SUBSTANTIVE line: H1/blockquote chrome + ## headers skipped,
    # the first bullet's text wins (记忆系统 §1.4「拟存主题文件首行」).
    store = FileMemoryStore(tmp_path)
    body = "# 用户记忆\n> 本文件由 AI 自动维护。\n\n## 要点\n- 先 build 再 deploy\n- 二线\n"
    await store.save("u1", "主题/部署流程.md", body)
    topics = await load_memory_topics(store, "u1", folder_id=None, enabled=True)
    assert topics == [MemoryTopic("部署流程", "先 build 再 deploy")]


def test_topic_summary_line_handles_freeform_truncation_and_empty():
    # Freeform first line (no bullet) is taken verbatim.
    assert topic_summary_line("自由文本第一行\n第二行") == "自由文本第一行"
    # Over-long summary is truncated with an ellipsis (directory stays cheap).
    summary = topic_summary_line("- " + "а" * 100)
    assert summary.endswith("…") and len(summary) == 60
    # Empty / chrome-only note → "" so the directory shows just the name.
    assert topic_summary_line("") == ""
    assert topic_summary_line("# 用户记忆\n> 注释\n") == ""
