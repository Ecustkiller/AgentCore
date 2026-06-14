"""Memory system.

Two layers (see docs/Agent记忆与知识系统.md):
- working memory: in-memory conversation history + TaskWorkspace (runtime data)
- long-term memory: an `ai_maintained` `rule` file in the user's file tree,
  maintained via structured ops (LLM decides, deterministic code applies)

Plus auto conversation titles (a sidebar UX feature, not a memory layer).

The former cross-session "session summary" layer was dropped — it fed the
orchestrator (planning, not content) and duplicated the long-term rule file.

This module owns: long-term-memory ops extraction (`LLMMemoryExtractor`) +
deterministic application (`MarkdownMemoryApplier`), per-turn maintenance
orchestration (`maintain_user_memory`), the memory file store (`MemoryStore`;
MVP `FileMemoryStore` backs one markdown file per user on disk until the cloud
file tree lands), and the conversation title generator.
"""

from agentcore.memory.conversation_title import (
    TITLE_MAX_CHARS,
    ChatMessage,
    LLMTitleGenerator,
    TitleGenerator,
    TitleInput,
)
from agentcore.memory.maintenance import maintain_user_memory
from agentcore.memory.store import (
    FileMemoryStore,
    MemoryStore,
    default_memory_store,
)
from agentcore.memory.user_memory import (
    MEMORY_SECTIONS,
    LLMMemoryExtractor,
    MarkdownMemoryApplier,
    MemoryAction,
    MemoryApplier,
    MemoryExtractInput,
    MemoryExtractor,
    MemoryOp,
    parse_memory_ops,
)

__all__ = [
    "ChatMessage",
    "TitleInput",
    "TitleGenerator",
    "LLMTitleGenerator",
    "TITLE_MAX_CHARS",
    "MEMORY_SECTIONS",
    "MemoryAction",
    "MemoryOp",
    "MemoryExtractInput",
    "MemoryExtractor",
    "MemoryApplier",
    "MarkdownMemoryApplier",
    "LLMMemoryExtractor",
    "parse_memory_ops",
    "MemoryStore",
    "FileMemoryStore",
    "default_memory_store",
    "maintain_user_memory",
]
