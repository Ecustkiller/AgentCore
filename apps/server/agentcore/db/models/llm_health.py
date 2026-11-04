"""Per-model reachability, so the picker can tell a dead id from a slow one.

``user_llm_providers.status`` answers "does this endpoint take my key" once, at
key-save time. It says nothing about the individual model ids, which is where
this actually breaks: OpenRouter rotates its ``:free`` tier without notice, so a
saved profile keeps pointing at an id nobody serves and every turn 404s with the
provider's raw copy. The catalog cannot notice on its own either — a *seeded*
id is listed whether or not it still exists, and discovery only covers what the
provider currently advertises.

One row per (user, provider, model): what the last probe saw, when, and how long
it took. ``dead`` is the only status that greys a model out, because it is the
only one that will not fix itself; ``throttled`` / ``error`` are shown but stay
selectable.
"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class LlmModelHealth(Base):
    __tablename__ = "llm_model_health"
    __table_args__ = (
        CheckConstraint(
            "status in ('ok', 'dead', 'throttled', 'error')",
            name="ck_llm_model_health_status",
        ),
        UniqueConstraint(
            "user_id", "provider_id", "model_id", name="uq_llm_model_health_target"
        ),
        Index("ix_llm_model_health_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    # Owning account (app-level FK → users; account注销 cascades these rows).
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    # Which BYOK provider row this model runs on.
    provider_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    model_id: Mapped[str] = mapped_column(String(200))
    # 'ok' | 'dead' | 'throttled' | 'error' — see the module docstring for why only
    # 'dead' is allowed to make a model unselectable.
    status: Mapped[str] = mapped_column(String(20), server_default=text("'error'"))
    # Short, already-safe diagnosis (our own code, or the provider's phrase clipped).
    # Never the key, never a full upstream body.
    detail: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Round-trip of the probe call; null when it never got an answer.
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
