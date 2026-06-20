"""Per-run cost ledger: CostEvent.

Append-only ledger: one row per Run (= one Agent's participation in a turn;
the CEO/captain root counts as a row too). This is the single source of truth
for real money spent (不变量 #1) — ``Message.usage`` is only a display snapshot.
The team「工资单」(GET /messages/{id}/cost) is rebuilt by querying this table by
message_id, so it replays on reload without any extra snapshot column.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class CostEvent(Base):
    __tablename__ = "cost_events"
    __table_args__ = (
        CheckConstraint(
            "role in ('captain', 'member', 'arena', 'title', 'memory')",
            name="ck_cost_events_role",
        ),
        # Account-window aggregation (dashboard + quota): SUM over a user's recent
        # rows hits this composite index.
        Index("ix_cost_events_user_created", "user_id", "created_at"),
        # Team payroll: fetch every run row for one assistant turn.
        Index("ix_cost_events_message", "message_id"),
    )

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # The assistant turn this run belongs to (== the persisted Message.id), or
    # NULL for an off-turn background LLM call (标题生成 / 记忆整合, Gap C): those
    # belong to no turn, so they SUM into the account/conversation totals but stay
    # out of any single turn's per-message 工资单 (queried by message_id) and do
    # not inflate the「请求数」(COUNT(DISTINCT message_id) ignores NULL).
    message_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), nullable=True
    )
    # Idempotency: a retry of the same run must not double-bill, so run_id is
    # unique and the ledger write is an upsert-by-run_id.
    #
    # NOT a UUID: a delegated worker's id is namespaced ``del_<uuid>_N`` and a
    # revision's is ``<run>_rev2`` (same posture as RunSessionRow.run_id). A native
    # uuid column here silently broke billing — record_runs writes the turn as ONE
    # multi-row INSERT, so a single non-uuid member id aborted the whole batch
    # (captain row included), and the caller swallows it to a warning. Plain
    # strings, sized like RunSessionRow.
    run_id: Mapped[str] = mapped_column(String(128), unique=True)
    parent_run_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    agent_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    role: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(50))
    # Token counts ({input, output, reasoning, cache_hit, cache_miss}).
    tokens: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Money is always integer nano-USD (1 USD = 1e9), never float.
    # cost = {input, cached, output, total}.
    cost: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Redundant scalar total so window SUMs run on an integer column (precise +
    # index-friendly), instead of digging into the JSONB each time.
    cost_total_nano: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0")
    )
    currency: Mapped[str] = mapped_column(
        String(8), default="USD", server_default=text("'USD'")
    )
    rounds: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    duration_ms: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0")
    )
    # Correlation key to the turn's runtime logs: joins a spend row to its trace
    # (per-run `run_id` already correlates to worker logs; trace_id gives the
    # turn-level join). NULL on untraced (handoff) turns. See core/log_context.py.
    trace_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
