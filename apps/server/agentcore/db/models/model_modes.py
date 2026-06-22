"""User-defined 质量档 (custom model modes): ModelMode.

User-defined 质量档 (custom modes, llm/modes.py D2): a named set of team-role →
model assignments the user can pick per conversation. System presets
(economy/quality) are code-defined, NOT rows. Soft-deleted so a conversation/user
still referencing a removed mode resolves safely (falls back to default).
"""

from datetime import datetime

from sqlalchemy import DateTime, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class ModelMode(Base):
    __tablename__ = "model_modes"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Team-role → model id (e.g. {"ceo": "deepseek-v4-pro"}). Roles not present
    # inherit the base profile's model. Validated against the operator ceiling on
    # write and re-clamped on resolve (llm/modes.sanitize_assignments).
    assignments: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
