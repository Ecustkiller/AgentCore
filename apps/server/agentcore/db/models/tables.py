"""Creation-tool 多维表格 (account-scoped typed grid).

A table is owned by ``user_id`` (照白板，不挂文件夹). Schema (columns) is JSONB
with ``schema_version`` CAS; rows and named views are sibling tables so two
editors can last-write-win different cells without a whole-table CAS.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class Table(Base):
    __tablename__ = "tables"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # Dedicated AI conversation, lazily bound on first sendTableTurn. App-level FK.
    conversation_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), index=True, nullable=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False, server_default=text("''"))
    # DB column ``schema``; attribute is not ``schema`` (that is SQLAlchemy's
    # PostgreSQL-schema slot on the mapper).
    columns_schema: Mapped[dict] = mapped_column(
        "schema",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{\"columns\": []}'::jsonb"),
    )
    schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    active_view_id: Mapped[str | None] = mapped_column(PG_UUID(as_uuid=False), nullable=True)
    # Last reversible batch: {id, inverses, row_stamps}. NULL = nothing to undo.
    undo_batch: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TableRow(Base):
    __tablename__ = "table_rows"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    table_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    cells: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    position: Mapped[float] = mapped_column(Float, nullable=False, server_default=text("1000"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TableView(Base):
    __tablename__ = "table_views"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    table_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, server_default=text("''"))
    display_mode: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default=text("'table'")
    )
    # filters, sort, group_by, hidden_column_ids, density, mode_config
    config: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    is_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
