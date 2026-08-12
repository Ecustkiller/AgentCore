"""Write-side always-entry quota (闸在写侧，读侧全量).

Meters injectable always-on rule bodies by character count. User edits of an
existing always entry may exceed the cap (allow + warning); AI create/merge that
would grow past the cap is refused and may push one ``memory_updates`` card per
pending fingerprint (same state → one card; user fix / content change resets).

See docs/03-AI核心/Agent记忆与知识系统.md「配额：闸在写侧，读侧全量」.
"""

from __future__ import annotations

import hashlib
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.models import Document
from agentcore.db.repositories import DocumentRepository, MemoryUpdateRepository
from agentcore.documents.frontmatter import strip_entry_frontmatter
from agentcore.memory.maintenance import MemoryUpdateItem
from agentcore.memory.store import memory_version

logger = get_logger(__name__)

# Set by consolidation / AI write paths that own a conversation_id for quota cards.
memory_write_conversation_id: ContextVar[str | None] = ContextVar(
    "memory_write_conversation_id", default=None
)

Writer = Literal["user", "ai"]

QUOTA_CARD_KIND = "quota"
_USER_OVER_WARNING = (
    "常驻条目已超配额（{used}/{max} 字符）。已保存；请删减或改为按需，以免撑爆上下文。"
)
_AI_DENIED_MESSAGE = (
    "常驻条目已满（{used}/{max} 字符），无法继续写入常驻。请删减或改为按需后再试。"
)
_CARD_SUMMARY = (
    "常驻条目已满（{used}/{max} 字符）。AI 已暂停写入常驻；请删减或改为按需后重试。"
)


@dataclass(frozen=True)
class AlwaysUsage:
    """UI-facing always-pool meter (percentage + absolute chars)."""

    used_chars: int
    max_chars: int
    fingerprint: str = ""

    @property
    def percent(self) -> float:
        if self.max_chars <= 0:
            return 0.0
        return round(min(100.0, 100.0 * self.used_chars / self.max_chars), 1)

    @property
    def over_limit(self) -> bool:
        return self.max_chars > 0 and self.used_chars > self.max_chars


@dataclass(frozen=True)
class AlwaysQuotaDecision:
    """Gate outcome for one prospective always write."""

    allowed: bool
    warning: str | None = None
    usage: AlwaysUsage | None = None
    message: str | None = None  # set when denied


class AlwaysQuotaExceededError(Exception):
    """AI write refused because the always pool would grow past the cap."""

    def __init__(self, usage: AlwaysUsage, message: str | None = None) -> None:
        self.usage = usage
        self.message = message or _AI_DENIED_MESSAGE.format(
            used=usage.used_chars, max=usage.max_chars
        )
        super().__init__(self.message)


def always_entry_chars(content: str) -> int:
    """Chars that count toward the always pool (frontmatter-stripped body).

    Unclosed / uninjectable frontmatter → 0 (matches read-side skip).
    """
    stripped = strip_entry_frontmatter(content)
    if stripped is None:
        return 0
    return len(stripped)


def always_max_chars() -> int:
    return int(settings.memory_always_max_chars)


def _fingerprint(docs: list[Document], *, used: int, max_chars: int) -> str:
    parts = [f"{d.id}:{memory_version(d.content)}" for d in sorted(docs, key=lambda x: x.id)]
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return f"{digest}:{used}:{max_chars}"


async def list_always_quota_docs(
    repo: DocumentRepository, user_id: str, *, folder_id: str | None
) -> list[Document]:
    """Always-on rule docs in the injection context (global + optional project)."""
    scopes: list[str | None] = [None] if folder_id is None else [None, folder_id]
    out: list[Document] = []
    for scope in scopes:
        for ai_maintained in (False, True):
            out.extend(
                await repo.list_injectable_rules(user_id, scope, ai_maintained=ai_maintained)
            )
    return out


async def measure_always_usage(
    repo: DocumentRepository, user_id: str, *, folder_id: str | None = None
) -> AlwaysUsage:
    """Current always-pool usage for the injection context of ``folder_id``."""
    docs = await list_always_quota_docs(repo, user_id, folder_id=folder_id)
    used = sum(always_entry_chars(d.content) for d in docs)
    max_chars = always_max_chars()
    return AlwaysUsage(
        used_chars=used,
        max_chars=max_chars,
        fingerprint=_fingerprint(docs, used=used, max_chars=max_chars),
    )


def project_usage_after(
    docs: list[Document],
    *,
    exclude_id: str | None,
    new_chars: int,
    new_is_always: bool,
) -> AlwaysUsage:
    """Usage if ``exclude_id`` is replaced by ``new_chars`` (0 / non-always = drop)."""
    kept = [d for d in docs if exclude_id is None or d.id != exclude_id]
    used = sum(always_entry_chars(d.content) for d in kept)
    if new_is_always:
        used += max(0, new_chars)
    max_chars = always_max_chars()
    # Fingerprint of the *current* set (pending-state identity before the write).
    current_chars = sum(always_entry_chars(d.content) for d in docs)
    return AlwaysUsage(
        used_chars=used,
        max_chars=max_chars,
        fingerprint=_fingerprint(docs, used=current_chars, max_chars=max_chars),
    )


def evaluate_always_write(
    *,
    writer: Writer,
    editing_existing_always: bool,
    current_used: int,
    projected: AlwaysUsage,
) -> AlwaysQuotaDecision:
    """Apply who-is-writing rules to a projected always-pool usage."""
    max_chars = projected.max_chars
    if max_chars <= 0:
        return AlwaysQuotaDecision(allowed=True, usage=projected)

    if projected.used_chars <= max_chars:
        return AlwaysQuotaDecision(allowed=True, usage=projected)

    # Over limit.
    if writer == "user" and editing_existing_always:
        return AlwaysQuotaDecision(
            allowed=True,
            warning=_USER_OVER_WARNING.format(used=projected.used_chars, max=max_chars),
            usage=projected,
        )

    # AI: refuse net growth past the cap. Shrink / same-size while already over is OK.
    if writer == "ai" and projected.used_chars <= current_used:
        return AlwaysQuotaDecision(allowed=True, usage=projected)

    msg = _AI_DENIED_MESSAGE.format(used=projected.used_chars, max=max_chars)
    if writer == "user":
        msg = (
            f"常驻条目配额不足（将达 {projected.used_chars}/{max_chars} 字符）。"
            "请先删减已有常驻或改为按需，再新建/提升为常驻。"
        )
    return AlwaysQuotaDecision(allowed=False, usage=projected, message=msg)


async def check_always_write(
    repo: DocumentRepository,
    user_id: str,
    *,
    folder_id: str | None,
    writer: Writer,
    editing_existing_always: bool,
    exclude_id: str | None,
    new_content: str,
    new_is_always: bool,
) -> AlwaysQuotaDecision:
    """Measure + decide for one prospective write against the always pool."""
    docs = await list_always_quota_docs(repo, user_id, folder_id=folder_id)
    current_used = sum(always_entry_chars(d.content) for d in docs)
    new_chars = always_entry_chars(new_content) if new_is_always else 0
    projected = project_usage_after(
        docs,
        exclude_id=exclude_id,
        new_chars=new_chars,
        new_is_always=new_is_always,
    )
    return evaluate_always_write(
        writer=writer,
        editing_existing_always=editing_existing_always,
        current_used=current_used,
        projected=projected,
    )


def _card_fingerprint(row_items: list | None, summary: str | None) -> str | None:
    if row_items:
        for it in row_items:
            if isinstance(it, dict) and it.get("action") == "quota":
                content = it.get("content")
                if isinstance(content, str) and content:
                    return content
    if summary and "fp:" in summary:
        # fallback — not used by current writer
        return summary.rsplit("fp:", 1)[-1].strip() or None
    return None


async def record_always_quota_card_once(
    session: AsyncSession,
    *,
    user_id: str,
    conversation_id: str,
    usage: AlwaysUsage,
):
    """Persist a quota card, or return ``None`` when the same pending fingerprint exists."""
    from agentcore.db.models import MemoryUpdateRow

    repo = MemoryUpdateRepository(session)
    rows = await repo.list_for_conversation(conversation_id, limit=50)
    latest = next((r for r in reversed(rows) if r.kind == QUOTA_CARD_KIND), None)
    if latest is not None and _card_fingerprint(latest.items, latest.summary) == usage.fingerprint:
        logger.info(
            "memory.always_quota_card_suppressed",
            conversation_id=conversation_id,
            fingerprint=usage.fingerprint,
        )
        return None

    summary = _CARD_SUMMARY.format(used=usage.used_chars, max=usage.max_chars)
    item = MemoryUpdateItem(
        action="quota",
        file="",
        section="",
        scope="global",
        content=usage.fingerprint,
        target="",
        project_id=None,
    )
    row: MemoryUpdateRow = await repo.record(
        conversation_id=conversation_id,
        user_id=user_id,
        items=[asdict(item)],
        kind=QUOTA_CARD_KIND,
        summary=summary,
    )
    logger.info(
        "memory.always_quota_card",
        conversation_id=conversation_id,
        used=usage.used_chars,
        max=usage.max_chars,
    )
    return row


async def notify_always_quota_exceeded(user_id: str, exc: AlwaysQuotaExceededError) -> None:
    """Best-effort card push when an AI write hits the always cap."""
    import contextlib

    conversation_id = memory_write_conversation_id.get()
    if not conversation_id:
        return
    from agentcore.db.base import async_session_factory
    from agentcore.messaging.hub import default_chat_hub

    try:
        async with async_session_factory() as session:
            row = await record_always_quota_card_once(
                session,
                user_id=user_id,
                conversation_id=conversation_id,
                usage=exc.usage,
            )
            if row is None:
                return
            update_payload = {
                "id": row.id,
                "conversation_id": conversation_id,
                "created_at": row.created_at.isoformat(),
                "kind": row.kind,
                "summary": row.summary,
                "items": row.items,
            }
        with contextlib.suppress(Exception):
            await default_chat_hub().publish(
                [user_id],
                {
                    "type": "memory_updated",
                    "conversation_id": conversation_id,
                    "kind": QUOTA_CARD_KIND,
                    "update": update_payload,
                },
            )
    except Exception as e:  # noqa: BLE001 - card is best-effort
        logger.warning(
            "memory.always_quota_card_failed",
            user_id=user_id,
            error=str(e),
        )
