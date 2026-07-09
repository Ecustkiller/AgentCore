"""Memory system.

Two layers (see docs/03-AI核心/Agent记忆与知识系统.md):
- working memory: in-memory conversation history + per-turn run state (runtime data)
- long-term memory: an `ai_maintained` `rule` file in the user's file tree,
  maintained via structured ops (LLM decides, deterministic code applies)

Plus auto conversation titles (a sidebar UX feature, not a memory layer).

The former cross-session "session summary" layer was dropped — it fed the
orchestrator (planning, not content) and duplicated the long-term rule file.

This module owns: long-term-memory ops extraction (`LLMMemoryExtractor`) +
deterministic application (`MarkdownMemoryApplier`), per-turn maintenance
orchestration (`maintain_user_memory`), the memory file store (`MemoryStore`;
MVP `FileMemoryStore` backs a per-user folder of markdown files on disk until the
cloud file tree lands), and the conversation title generator.
"""

from agentcore.memory.conversation_title import (
    TITLE_MAX_CHARS,
    ChatMessage,
    LLMTitleGenerator,
    TitleGenerator,
    TitleInput,
    TitleResult,
)
from agentcore.memory.followups import (
    FOLLOWUPS_MAX,
    FollowupInput,
    FollowupsGenerator,
    LLMFollowupsGenerator,
)
from agentcore.memory.injection import MemoryTopic, load_injected_memory, load_memory_topics
from agentcore.memory.maintenance import MemoryUpdateItem, maintain_user_memory
from agentcore.memory.store import (
    ALWAYS_MEMORY_FILES,
    CORE_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    TOPIC_DIR,
    FileMemoryStore,
    MemoryFileMeta,
    MemoryScope,
    MemoryStore,
    default_memory_store,
    is_topic_path,
    memory_version,
    topic_path,
    topic_slug,
)
from agentcore.memory.user_memory import (
    MEMORY_SECTIONS,
    PREFERENCES_SECTIONS,
    PROFILE_SECTIONS,
    LLMMemoryExtractor,
    MarkdownMemoryApplier,
    MemoryAction,
    MemoryApplier,
    MemoryExtractInput,
    MemoryExtractor,
    MemoryOp,
    core_file_for_section,
    merge_global_core,
    parse_memory_ops,
    split_global_core,
)

__all__ = [
    "ChatMessage",
    "TitleInput",
    "TitleResult",
    "TitleGenerator",
    "LLMTitleGenerator",
    "TITLE_MAX_CHARS",
    "FollowupInput",
    "FollowupsGenerator",
    "LLMFollowupsGenerator",
    "FOLLOWUPS_MAX",
    "MEMORY_SECTIONS",
    "PREFERENCES_SECTIONS",
    "PROFILE_SECTIONS",
    "core_file_for_section",
    "MemoryAction",
    "MemoryOp",
    "MemoryExtractInput",
    "MemoryExtractor",
    "MemoryApplier",
    "MarkdownMemoryApplier",
    "LLMMemoryExtractor",
    "parse_memory_ops",
    "merge_global_core",
    "split_global_core",
    "MemoryStore",
    "MemoryScope",
    "MemoryFileMeta",
    "FileMemoryStore",
    "CORE_MEMORY_FILE",
    "PREFERENCES_MEMORY_FILE",
    "ALWAYS_MEMORY_FILES",
    "TOPIC_DIR",
    "topic_path",
    "topic_slug",
    "is_topic_path",
    "default_memory_store",
    "memory_version",
    "maintain_user_memory",
    "MemoryUpdateItem",
    "load_injected_memory",
    "load_memory_topics",
    "MemoryTopic",
]
