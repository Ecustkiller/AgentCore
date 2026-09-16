"""AI-maintained notes stay on disk and do not enter the turn catalog."""

from agentcore.memory.injection import load_memory_topics
from agentcore.memory.store import FileMemoryStore


def _note(description: str, body: str = "## 要点\n- 内容\n") -> str:
    return f"---\napply: on_demand\ndescription: {description}\n---\n{body}"


async def test_memory_topics_never_enter_the_turn_catalog(tmp_path):
    store = FileMemoryStore(tmp_path)
    await store.save("u1", "主题/全局主题.md", _note("全局的检索描述"))
    await store.save("u1", "主题/项目主题.md", _note("项目的检索描述"), scope="F1")
    assert await load_memory_topics(store, "u1", folder_id="F1") == []
    assert await load_memory_topics(store, "u1", folder_id=None) == []
    assert (await store.load("u1", "主题/全局主题.md")).strip() != ""
