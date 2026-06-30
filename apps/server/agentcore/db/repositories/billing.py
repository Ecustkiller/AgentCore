"""Cost ledger data access (成本配额与计费): the append-only per-run spend store."""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import distinct, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from agentcore.core.types import new_id
from agentcore.db.models import CostEvent, User

from ._base import _json_int, _sum_int


class CostEventRepository:
    """Append-only per-run cost ledger (决策②: one row per Run = one Agent's
    participation in a turn, captain root included).

    This is the persistence truth source for money spent: the team payroll is
    rebuilt by querying on ``message_id`` and the account dashboard / quota SUMs
    by ``(user_id, created_at)`` — both reads land here and hit the two composite
    indexes on the table.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def record_runs(
        self,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str | None,
        runs: Sequence[dict],
        trace_id: str | None = None,
    ) -> int:
        """Append one ledger row per run for an assistant turn; return rows written.

        ``runs`` are the runtime's per-run payloads (``asdict(RunCost)``): the
        caller (conversation service) supplies the user / conversation / message
        envelope here so the runtime stays DB-unaware. Idempotent by ``run_id``
        (unique): a retried turn re-sending the same runs inserts nothing the
        second time, so a run is never double-billed. A row id is minted per row
        because a Core bulk insert does not fire the ORM-level default. ``trace_id``
        (the turn's log correlation key) stamps every row so the spend joins to its
        log trace.

        ``message_id`` is ``None`` for off-turn background LLM calls (标题生成 /
        记忆整合, Gap C) — those belong to no assistant turn, so the NULL keeps them
        out of any single turn's per-message 工资单 and out of the「请求数」count,
        while still summing into the account/conversation cost totals.
        """
        if not runs:
            return 0
        rows = [
            {
                "id": new_id(),
                "user_id": user_id,
                "conversation_id": conversation_id,
                "message_id": message_id,
                "run_id": r["run_id"],
                "parent_run_id": r.get("parent_run_id"),
                "agent_id": r.get("agent_id"),
                "role": r.get("role", "member"),
                "model": r.get("model", ""),
                "tokens": r.get("tokens") or {},
                "cost": r.get("cost") or {},
                "cost_total_nano": int(r.get("cost_total_nano", 0)),
                "currency": r.get("currency", "USD"),
                "rounds": int(r.get("rounds", 0)),
                "duration_ms": int(r.get("duration_ms", 0)),
                "trace_id": trace_id,
            }
            for r in runs
        ]
        stmt = pg_insert(CostEvent).values(rows).on_conflict_do_nothing(index_elements=["run_id"])
        result = await self._session.execute(stmt)
        await self._session.commit()
        return result.rowcount or 0

    async def list_for_message(self, message_id: str, *, user_id: str) -> Sequence[CostEvent]:
        """The per-run rows for one assistant turn — the team payroll (工资单).

        Scoped by ``user_id`` so a non-owner gets an empty list (never another
        user's spend, and no message-existence leak). Ordered oldest-first so the
        captain root (written first) heads the payroll.
        """
        result = await self._session.execute(
            select(CostEvent)
            .where(CostEvent.message_id == message_id, CostEvent.user_id == user_id)
            .order_by(CostEvent.created_at.asc())
        )
        return result.scalars().all()

    async def _aggregate(self, *conditions: ColumnElement) -> dict:
        """SUM tokens/cost/rounds + distinct-turn count over the given filter.

        One round-trip returns the whole rollup the cost endpoints need. Token
        and cost-breakdown components live in JSONB (summed via cast); the turn
        total uses the redundant ``cost_total_nano`` scalar column (precise, and
        index-friendly for the account window). ``turns`` counts distinct
        ``message_id`` — the「请求/回合」proxy for the conversation total + quota.
        """
        stmt = select(
            _sum_int(_json_int(CostEvent.tokens, "input")).label("t_input"),
            _sum_int(_json_int(CostEvent.tokens, "output")).label("t_output"),
            _sum_int(_json_int(CostEvent.tokens, "reasoning")).label("t_reasoning"),
            _sum_int(_json_int(CostEvent.tokens, "cache_hit")).label("t_cache_hit"),
            _sum_int(_json_int(CostEvent.tokens, "cache_miss")).label("t_cache_miss"),
            _sum_int(_json_int(CostEvent.cost, "input")).label("c_input"),
            _sum_int(_json_int(CostEvent.cost, "cached")).label("c_cached"),
            _sum_int(_json_int(CostEvent.cost, "output")).label("c_output"),
            _sum_int(CostEvent.cost_total_nano).label("c_total"),
            _sum_int(CostEvent.rounds).label("rounds"),
            func.count(distinct(CostEvent.message_id)).label("turns"),
        ).where(*conditions)
        row = (await self._session.execute(stmt)).one()
        return {
            "usage": {
                "input": int(row.t_input),
                "output": int(row.t_output),
                "reasoning": int(row.t_reasoning),
                "cache_hit": int(row.t_cache_hit),
                "cache_miss": int(row.t_cache_miss),
            },
            "cost": {
                "input": int(row.c_input),
                "cached": int(row.c_cached),
                "output": int(row.c_output),
                "total": int(row.c_total),
            },
            "rounds": int(row.rounds),
            "turns": int(row.turns),
        }

    async def aggregate_for_conversation(self, conversation_id: str, *, user_id: str) -> dict:
        """Cumulative spend for one conversation (对话累计)."""
        return await self._aggregate(
            CostEvent.conversation_id == conversation_id,
            CostEvent.user_id == user_id,
        )

    async def aggregate_for_window(self, *, user_id: str | None = None, since: datetime) -> dict:
        """Spend since a cutoff. ``user_id`` scopes to one account (account dashboard
        today / month window, hits ``ix_cost_events_user_created``); ``None``
        aggregates platform-wide (admin 全站用量看板 — every account).
        """
        conditions: list[ColumnElement] = [CostEvent.created_at >= since]
        if user_id is not None:
            conditions.append(CostEvent.user_id == user_id)
        return await self._aggregate(*conditions)

    async def aggregate_by_role_for_window(
        self, *, user_id: str | None = None, since: datetime
    ) -> list[dict]:
        """Per-role spend since a cutoff (本月各角色花销 — 团队工资单 by role).

        Groups the window by the ledger ``role`` and SUMs the scalar
        ``cost_total_nano`` (the money truth, index-friendly) plus a distinct-turn
        count per role. Only roles that actually spent (>0) are returned, ordered
        by spend desc so the dashboard leads with the biggest spender (Top 花销) —
        the multi-agent product differentiator a single-agent tool can't show.
        ``user_id`` scopes to one account (hits ``ix_cost_events_user_created``);
        ``None`` is platform-wide (admin 全站看板).
        """
        total = _sum_int(CostEvent.cost_total_nano)
        conditions: list[ColumnElement] = [CostEvent.created_at >= since]
        if user_id is not None:
            conditions.append(CostEvent.user_id == user_id)
        stmt = (
            select(
                CostEvent.role.label("role"),
                total.label("c_total"),
                func.count(distinct(CostEvent.message_id)).label("turns"),
            )
            .where(*conditions)
            .group_by(CostEvent.role)
            .having(total > 0)
            .order_by(total.desc())
        )
        rows = (await self._session.execute(stmt)).all()
        return [
            {"role": row.role, "cost_total": int(row.c_total), "turns": int(row.turns)}
            for row in rows
        ]

    async def aggregate_daily_for_window(
        self, *, user_id: str | None = None, since: datetime
    ) -> dict[str, int]:
        """Daily spend (UTC days) since a cutoff — the dashboard 7-day trend sparkline.

        Groups the window into UTC calendar days and SUMs ``cost_total_nano`` per
        day, returning an ``{iso_date: nano_total}`` map (only days that had rows).
        The caller zero-fills the absent days so the series is a fixed length. The
        day key is computed in UTC (``created_at AT TIME ZONE 'UTC'``) to match the
        account window boundaries. ``user_id`` scopes to one account (hits
        ``ix_cost_events_user_created``); ``None`` is platform-wide (admin 看板).
        """
        day = func.date_trunc("day", func.timezone("UTC", CostEvent.created_at))
        conditions: list[ColumnElement] = [CostEvent.created_at >= since]
        if user_id is not None:
            conditions.append(CostEvent.user_id == user_id)
        stmt = (
            select(
                day.label("day"),
                _sum_int(CostEvent.cost_total_nano).label("c_total"),
            )
            .where(*conditions)
            .group_by(day)
        )
        rows = (await self._session.execute(stmt)).all()
        return {row.day.date().isoformat(): int(row.c_total) for row in rows}

    async def aggregate_by_user_for_window(self, *, since: datetime, limit: int = 20) -> list[dict]:
        """Per-user spend since a cutoff — the platform 工资单 by user (admin 全站看板).

        The cross-user counterpart of ``aggregate_by_role_for_window``: groups the
        (platform-wide) window by ``user_id`` and SUMs the scalar ``cost_total_nano``
        plus a distinct-turn count, joining ``users`` for the display identity. Only
        accounts that actually spent (>0) are returned, ordered by spend desc and
        capped at ``limit`` (Top spenders) — no user filter, this is the whole
        platform. Money is integer nano-USD; the caller formats ¥ from the single
        ``cny_per_usd`` rate.
        """
        total = _sum_int(CostEvent.cost_total_nano)
        stmt = (
            select(
                CostEvent.user_id.label("user_id"),
                User.username.label("username"),
                User.display_name.label("display_name"),
                total.label("c_total"),
                func.count(distinct(CostEvent.message_id)).label("turns"),
            )
            .join(User, User.user_id == CostEvent.user_id)
            .where(CostEvent.created_at >= since)
            .group_by(CostEvent.user_id, User.username, User.display_name)
            .having(total > 0)
            .order_by(total.desc())
            .limit(limit)
        )
        rows = (await self._session.execute(stmt)).all()
        return [
            {
                "user_id": row.user_id,
                "username": row.username,
                "display_name": row.display_name,
                "cost_total": int(row.c_total),
                "turns": int(row.turns),
            }
            for row in rows
        ]

    async def aggregate_cost_by_message_for_conversation(
        self, conversation_id: str
    ) -> dict[str, int]:
        """Per-turn spend for one conversation, keyed by ``message_id`` (会话复盘).

        Groups the conversation's ledger rows by the assistant turn they belong to
        (``message_id``) and SUMs the scalar ``cost_total_nano``. Off-turn rows
        (标题/记忆, ``message_id`` NULL) are excluded — they belong to no turn. The
        admin 复盘 view attaches each turn's ¥ from this map (no re-pricing; the
        caller folds the single ``cny_per_usd`` rate).
        """
        stmt = (
            select(
                CostEvent.message_id.label("message_id"),
                _sum_int(CostEvent.cost_total_nano).label("c_total"),
            )
            .where(
                CostEvent.conversation_id == conversation_id,
                CostEvent.message_id.is_not(None),
            )
            .group_by(CostEvent.message_id)
        )
        rows = (await self._session.execute(stmt)).all()
        return {row.message_id: int(row.c_total) for row in rows}

    async def aggregate_cost_by_conversations(
        self, conversation_ids: Sequence[str]
    ) -> dict[str, int]:
        """All-time spend per conversation, keyed by ``conversation_id`` (admin roster).

        One GROUP BY over the given ids so the 对话 page enriches each row without
        an N+1. Ids with no ledger rows are absent (callers default to 0).
        """
        if not conversation_ids:
            return {}
        stmt = (
            select(
                CostEvent.conversation_id.label("conversation_id"),
                _sum_int(CostEvent.cost_total_nano).label("c_total"),
            )
            .where(CostEvent.conversation_id.in_(conversation_ids))
            .group_by(CostEvent.conversation_id)
        )
        rows = (await self._session.execute(stmt)).all()
        return {row.conversation_id: int(row.c_total) for row in rows}
