"""Long-term memory maintenance: tie consolidation + application + storage.

Driven by the offline consolidation pass (see memory/consolidation.py), which
feeds the recent conversation window — not a single turn. Best-effort: any failure
is logged and swallowed so memory maintenance never breaks a turn. The "LLM
decides, code applies" split lives in user_memory.py; this module just orchestrates
load -> consolidate -> apply -> save.
"""

from collections import defaultdict
from collections.abc import Sequence

from agentcore.core.logging import get_logger
from agentcore.memory.conversation_title import ChatMessage
from agentcore.memory.store import (
    CORE_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    MemoryScope,
    MemoryStore,
    is_topic_path,
    topic_slug,
)
from agentcore.memory.user_memory import (
    MarkdownMemoryApplier,
    MemoryApplier,
    MemoryExtractInput,
    MemoryExtractor,
    MemoryOp,
)

logger = get_logger(__name__)


def _enforce_topic_cap(
    ops: Sequence[MemoryOp],
    existing_topics_by_scope: dict[MemoryScope, set[str]],
    cap: int | None,
) -> list[MemoryOp]:
    """Drop ops that would create a NEW topic note beyond ``cap`` — PER SCOPE (anti-bloat).

    Core ops and ops on an already-existing topic always pass; new topic files are admitted
    until that scope's total reaches ``cap``, then dropped (记忆作用域与画像分层 §5.3「按作用域
    各算一份」). A non-positive / None cap means no limit. The cap is counted independently
    for the global and each project layer, since they are separate folders.
    """
    if not cap or cap <= 0:
        return list(ops)
    allowed = {scope: set(topics) for scope, topics in existing_topics_by_scope.items()}
    kept: list[MemoryOp] = []
    for op in ops:
        if not is_topic_path(op.file):
            kept.append(op)
            continue
        scope_allowed = allowed.setdefault(op.scope, set())
        if op.file in scope_allowed:
            kept.append(op)
        elif len(scope_allowed) < cap:
            scope_allowed.add(op.file)
            kept.append(op)
        else:
            logger.info("memory.topic_cap_reached", file=op.file, scope=op.scope, cap=cap)
    return kept


async def maintain_user_memory(
    *,
    user_id: str,
    messages: Sequence[ChatMessage],
    extractor: MemoryExtractor,
    store: MemoryStore,
    applier: MemoryApplier | None = None,
    today: str = "",
    section_cap: int | None = None,
    max_topic_files: int | None = None,
    project_id: str | None = None,
) -> bool:
    """Consolidate durable knowledge from `messages` into the user's memory folders.

    `messages` is the recent conversation window (reconciled against existing memory).
    `today` (ISO date) enables temporal refresh; `section_cap` bounds bullets per section;
    `max_topic_files` caps on-demand topic notes per scope. `project_id` is the
    conversation's folder (None for a bare chat): it unlocks the PROJECT scope so a fact
    true only in this project lands in the project layer instead of polluting global memory
    (记忆作用域与画像分层 §三).

    The extractor sees both the global preferences/profile/topics and (when in a project)
    the project's profile/topics, then emits ops targeting a `(scope, file)`. Ops are grouped
    per `(scope, file)` and applied independently, so a per-file CAS / edit only touches the
    notes that moved. Returns True iff at least one memory file changed. No ops (or a no-op
    apply) skips the write. Never raises — failures are logged and swallowed.
    """
    if not messages:
        return False
    applier = applier or MarkdownMemoryApplier(section_cap=section_cap)
    try:
        global_topics = {m.path for m in await store.list(user_id) if is_topic_path(m.path)}
        project_topics: set[str] = set()
        project_profile = ""
        if project_id:
            project_topics = {
                m.path for m in await store.list(user_id, scope=project_id) if is_topic_path(m.path)
            }
            project_profile = await store.load(user_id, CORE_MEMORY_FILE, scope=project_id)
        ops = await extractor.extract(
            MemoryExtractInput(
                user_id=user_id,
                current_memory=await store.load(user_id, CORE_MEMORY_FILE),
                current_preferences=await store.load(user_id, PREFERENCES_MEMORY_FILE),
                project_id=project_id,
                current_project_memory=project_profile,
                messages=messages,
                today=today,
                topic_files=sorted(topic_slug(path) for path in global_topics),
                project_topic_files=sorted(topic_slug(path) for path in project_topics),
            )
        )
        if not ops:
            return False
        # Existing topics per scope for the cap. Only add the project key when there IS a
        # project — otherwise ``{None: ..., None: ...}`` would collapse and lose the global set.
        existing_by_scope: dict[MemoryScope, set[str]] = {None: global_topics}
        if project_id:
            existing_by_scope[project_id] = project_topics
        ops = _enforce_topic_cap(ops, existing_by_scope, max_topic_files)
        # Group by the (scope, file) target so each note is loaded/applied/saved once and a
        # per-file CAS only fires for notes that actually moved.
        by_target: dict[tuple[MemoryScope, str], list[MemoryOp]] = defaultdict(list)
        for op in ops:
            by_target[(op.scope, op.file)].append(op)
        changed_files = 0
        for (scope, file), file_ops in by_target.items():
            current = await store.load(user_id, file, scope=scope)
            updated = applier.apply(current, file_ops)
            if updated != current:
                await store.save(user_id, file, updated, scope=scope)
                changed_files += 1
        if changed_files:
            logger.info("memory.user_updated", user_id=user_id, ops=len(ops), files=changed_files)
        return changed_files > 0
    except Exception as e:
        logger.warning("memory.user_maintain_failed", user_id=user_id, error=str(e))
        return False
