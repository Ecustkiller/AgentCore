"""Unit tests for document write guards (AI core leaf identity)."""

from __future__ import annotations

from agentcore.documents.write_guards import (
    AI_CORE_MEMORY_NAMES,
    is_ai_core_memory_leaf,
)
from agentcore.memory.store import (
    CORE_MEMORY_FILE,
    NAVIGATION_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    topic_path,
)


def test_core_names_match_memory_store_constants():
    assert frozenset(
        {PREFERENCES_MEMORY_FILE, CORE_MEMORY_FILE, NAVIGATION_MEMORY_FILE}
    ) == AI_CORE_MEMORY_NAMES


def test_ai_core_leaves_identified_by_name_and_flag():
    assert is_ai_core_memory_leaf(name="画像.md", ai_maintained=True)
    assert is_ai_core_memory_leaf(name="偏好.md", ai_maintained=True)
    assert is_ai_core_memory_leaf(name="导航.md", ai_maintained=True)


def test_user_owned_same_name_is_not_core():
    assert not is_ai_core_memory_leaf(name="画像.md", ai_maintained=False)


def test_ai_topic_is_not_core():
    assert not is_ai_core_memory_leaf(
        name=topic_path("部署"), ai_maintained=True
    )
