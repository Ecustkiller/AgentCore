"""Long-term memory maintenance: tie extraction + application + storage.

Called once per turn at finalize (see conversation/service.py). Best-effort:
any failure is logged and swallowed so memory maintenance never breaks a turn.
The "LLM decides, code applies" split lives in user_memory.py; this module just
orchestrates load -> extract -> apply -> save.
"""

from collections.abc import Sequence

from agentcore.core.logging import get_logger
from agentcore.memory.conversation_title import ChatMessage
from agentcore.memory.store import MemoryStore
from agentcore.memory.user_memory import (
    MarkdownMemoryApplier,
    MemoryApplier,
    MemoryExtractInput,
    MemoryExtractor,
)

logger = get_logger(__name__)


async def maintain_user_memory(
    *,
    user_id: str,
    messages: Sequence[ChatMessage],
    extractor: MemoryExtractor,
    store: MemoryStore,
    applier: MemoryApplier | None = None,
) -> bool:
    """Merge durable facts extracted from `messages` into the user's memory file.

    Returns True iff the memory file changed. No extracted ops (or a no-op apply)
    skips the write. Never raises — failures are logged and swallowed.
    """
    if not messages:
        return False
    applier = applier or MarkdownMemoryApplier()
    try:
        current = await store.load(user_id)
        ops = await extractor.extract(
            MemoryExtractInput(user_id=user_id, current_memory=current, messages=messages)
        )
        if not ops:
            return False
        updated = applier.apply(current, ops)
        if updated == current:
            return False
        await store.save(user_id, updated)
        logger.info("user_memory_updated", user_id=user_id, ops=len(ops))
        return True
    except Exception as e:
        logger.warning("user_memory_maintain_failed", user_id=user_id, error=str(e))
        return False
