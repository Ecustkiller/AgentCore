"""Tests for memory injection assembly (global + project layers, 记忆作用域与画像分层 §5.2)."""

from agentcore.memory.injection import load_injected_memory, load_memory_topics
from agentcore.memory.store import CORE_MEMORY_FILE, PREFERENCES_MEMORY_FILE, FileMemoryStore


async def test_injected_memory_combines_preferences_and_profile(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", PREFERENCES_MEMORY_FILE, "## 沟通偏好\n- 用中文\n")
    await store.save("u1", CORE_MEMORY_FILE, "## 技术栈与工具\n- 用 Python\n")
    body = await load_injected_memory(store, "u1", folder_id=None, enabled=True)
    assert "用中文" in body
    assert "用 Python" in body


async def test_injected_memory_appends_project_layer_after_global(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", CORE_MEMORY_FILE, "## 技术栈与工具\n- 用 Python\n")
    await store.save("u1", CORE_MEMORY_FILE, "## 关于用户的事实\n- 本项目用 Rust\n", scope="F1")
    body = await load_injected_memory(store, "u1", folder_id="F1", enabled=True)
    assert "用 Python" in body
    assert "本项目用 Rust" in body
    # Global is the stable prefix → comes before the labeled project layer.
    assert body.index("用 Python") < body.index("本项目用 Rust")


async def test_injected_memory_skips_project_layer_for_bare_chat(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", CORE_MEMORY_FILE, "## 关于用户的事实\n- 本项目用 Rust\n", scope="F1")
    body = await load_injected_memory(store, "u1", folder_id=None, enabled=True)
    assert "本项目用 Rust" not in body


async def test_injected_memory_strips_chrome_per_file(tmp_path):
    store = FileMemoryStore(tmp_path)
    chrome = "# 用户记忆\n> 本文件由 AI 自动维护，你可随时编辑或删除任何条目。\n\n"
    await store.save("u1", PREFERENCES_MEMORY_FILE, chrome + "## 沟通偏好\n- 用中文\n")
    await store.save("u1", CORE_MEMORY_FILE, chrome + "## 技术栈与工具\n- 用 Python\n")
    body = await load_injected_memory(store, "u1", folder_id=None, enabled=True)
    # The human chrome of BOTH files is shed (not just the first) — it's stripped per file.
    assert "本文件由 AI 自动维护" not in body
    assert "用中文" in body and "用 Python" in body


async def test_injected_memory_empty_when_disabled(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", CORE_MEMORY_FILE, "## 技术栈与工具\n- 用 Python\n")
    assert await load_injected_memory(store, "u1", folder_id=None, enabled=False) == ""


async def test_memory_topics_merge_global_and_project(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/全局主题.md", "## 要点\n- g\n")
    await store.save("u1", "主题/项目主题.md", "## 要点\n- p\n", scope="F1")
    topics = await load_memory_topics(store, "u1", folder_id="F1", enabled=True)
    assert topics == ["全局主题", "项目主题"]


async def test_memory_topics_dedupe_across_scopes(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/部署.md", "## 要点\n- g\n")
    await store.save("u1", "主题/部署.md", "## 要点\n- p\n", scope="F1")
    topics = await load_memory_topics(store, "u1", folder_id="F1", enabled=True)
    assert topics == ["部署"]


async def test_memory_topics_empty_when_disabled(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/部署.md", "## 要点\n- g\n")
    assert await load_memory_topics(store, "u1", folder_id=None, enabled=False) == []
