"""Execution-domain data access: handoff jobs, recoverable run sessions, paused
turns, the turn journal (唯一事实源) and per-turn metrics (观测看板)."""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import and_, case, delete, distinct, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import (
    Conversation,
    HandoffJob,
    PausedTurnRow,
    RunSessionRow,
    TurnJournalRow,
    TurnMetricsRow,
    User,
)


class HandoffJobRepository:
    """Local→云 handoff jobs (双模式工作区 P2e / e2): a dispatched cloud team run.

    Tracks one job's lifecycle (pending → running → succeeded/failed) and the two
    snapshot ids that bracket it (the base it ran on, the result it produced). All
    reads are owner-scoped so a non-owner gets nothing (IDOR-safe), mirroring the
    conversation repo.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        source_conversation_id: str,
        job_conversation_id: str,
        base_snapshot_id: str,
        task: str,
    ) -> HandoffJob:
        job = HandoffJob(
            id=new_id(),
            user_id=user_id,
            source_conversation_id=source_conversation_id,
            job_conversation_id=job_conversation_id,
            base_snapshot_id=base_snapshot_id,
            task=task,
        )
        self._session.add(job)
        await self._session.commit()
        await self._session.refresh(job)
        return job

    async def get_by_id(self, job_id: str, *, user_id: str | None = None) -> HandoffJob | None:
        conditions = [HandoffJob.id == job_id]
        if user_id is not None:
            conditions.append(HandoffJob.user_id == user_id)
        result = await self._session.execute(select(HandoffJob).where(*conditions))
        return result.scalar_one_or_none()

    async def list_for_source(
        self, source_conversation_id: str, *, user_id: str
    ) -> Sequence[HandoffJob]:
        """A source conversation's handoff jobs, newest first (owner-scoped)."""
        result = await self._session.execute(
            select(HandoffJob)
            .where(
                HandoffJob.source_conversation_id == source_conversation_id,
                HandoffJob.user_id == user_id,
            )
            .order_by(HandoffJob.created_at.desc())
        )
        return result.scalars().all()

    async def mark_running(self, job_id: str) -> None:
        await self._session.execute(
            update(HandoffJob).where(HandoffJob.id == job_id).values(status="running")
        )
        await self._session.commit()

    async def mark_succeeded(self, job_id: str, *, result_snapshot_id: str) -> None:
        await self._session.execute(
            update(HandoffJob)
            .where(HandoffJob.id == job_id)
            .values(
                status="succeeded",
                result_snapshot_id=result_snapshot_id,
                finished_at=datetime.now(UTC),
            )
        )
        await self._session.commit()

    async def mark_failed(self, job_id: str, *, error: str) -> None:
        await self._session.execute(
            update(HandoffJob)
            .where(HandoffJob.id == job_id)
            .values(status="failed", error=error, finished_at=datetime.now(UTC))
        )
        await self._session.commit()


class RunSessionRepository:
    """Durable store for recoverable worker runs (留人 跨进程落盘, 乙 热修 P3).

    The write path is an upsert by ``run_id``: a freshly-delegated worker inserts;
    a later ``revise`` of the same run updates its transcript / content /
    recall_count and bumps ``updated_at`` (which the TTL sweep reads). The read path
    rehydrates a single run on an in-memory roster miss (restart / eviction).
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(
        self,
        *,
        conversation_id: str,
        run_id: str,
        spec: dict,
        transcript: list,
        content: str,
        recall_count: int,
        trace_id: str | None = None,
    ) -> None:
        """Insert a recoverable session, or update it in place if its ``run_id``
        already exists (a re-revised run). Idempotent re-delegation re-writes the
        same content; a revision advances transcript / recall_count. ``trace_id``
        is set on first insert only (NOT in the update set) so it keeps pointing at
        the interaction that originally spawned the worker, not a later revise."""
        now = datetime.now()
        stmt = (
            pg_insert(RunSessionRow)
            .values(
                run_id=run_id,
                conversation_id=conversation_id,
                spec=spec,
                transcript=transcript,
                content=content,
                recall_count=recall_count,
                trace_id=trace_id,
            )
            .on_conflict_do_update(
                index_elements=["run_id"],
                set_={
                    "spec": spec,
                    "transcript": transcript,
                    "content": content,
                    "recall_count": recall_count,
                    "updated_at": now,
                },
            )
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def get(self, run_id: str) -> RunSessionRow | None:
        result = await self._session.execute(
            select(RunSessionRow).where(RunSessionRow.run_id == run_id)
        )
        return result.scalar_one_or_none()

    async def delete_stale(self, *, before: datetime, limit: int) -> int:
        """Delete up to ``limit`` sessions idle since before ``before`` (7-day TTL).
        Batched so a sweep never holds one huge transaction; returns rows removed."""
        stale = select(RunSessionRow.run_id).where(RunSessionRow.updated_at < before).limit(limit)
        result = await self._session.execute(
            delete(RunSessionRow).where(RunSessionRow.run_id.in_(stale))
        )
        await self._session.commit()
        return result.rowcount or 0

    async def delete_for_conversation(self, conversation_id: str) -> int:
        """Cascade-clear recoverable sessions when a conversation is soft/hard deleted.

        现场生命周期跟随对话：对话不在则现场不可唤回。Does not commit — caller owns the txn.
        """
        result = await self._session.execute(
            delete(RunSessionRow).where(RunSessionRow.conversation_id == conversation_id)
        )
        return int(result.rowcount or 0)


class PausedTurnRepository:
    """Durable store for turns suspended at a plan_review checkpoint (结构化挂起
    turn 级落盘).

    Write is an upsert keyed by the turn's ``message_id`` (re-pausing the same turn
    after a resume-then-pause overwrites in place). The read path either claims one
    row for resume (``claim`` = read-then-delete in one transaction, so two racing
    ``/resume`` calls can't both continue the same turn) or lists a conversation's
    pending paused turns for reopen. ``trace_id`` is set on first insert only so it
    keeps pointing at the originating interaction.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(
        self,
        *,
        message_id: str,
        conversation_id: str,
        user_id: str,
        frame: dict,
        trace_id: str | None = None,
    ) -> None:
        now = datetime.now(UTC)
        stmt = (
            pg_insert(PausedTurnRow)
            .values(
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                frame=frame,
                trace_id=trace_id,
            )
            .on_conflict_do_update(
                index_elements=["message_id"],
                set_={"frame": frame, "updated_at": now},
            )
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def get(self, message_id: str) -> PausedTurnRow | None:
        result = await self._session.execute(
            select(PausedTurnRow).where(PausedTurnRow.message_id == message_id)
        )
        return result.scalar_one_or_none()

    async def claim(
        self, message_id: str, *, conversation_id: str | None = None
    ) -> PausedTurnRow | None:
        """Atomically read-and-delete one paused turn for resume.

        DELETE ... RETURNING means only ONE caller wins the row (a second concurrent
        ``/resume`` gets ``None`` → 404), so a paused turn is never resumed twice.
        Scoped to ``conversation_id`` when given so a frame is only ever claimed
        within the conversation the caller has already proven it owns (IDOR-safe — a
        guessed ``message_id`` from another conversation won't match, so it is neither
        returned nor deleted). Returns the row (detached values) or ``None``.
        """
        stmt = delete(PausedTurnRow).where(PausedTurnRow.message_id == message_id)
        if conversation_id is not None:
            stmt = stmt.where(PausedTurnRow.conversation_id == conversation_id)
        result = await self._session.execute(stmt.returning(PausedTurnRow))
        row = result.scalar_one_or_none()
        await self._session.commit()
        return row

    async def list_pending(self, conversation_id: str) -> Sequence[PausedTurnRow]:
        """A conversation's paused turns (oldest first) for reopen-time rehydration."""
        result = await self._session.execute(
            select(PausedTurnRow)
            .where(PausedTurnRow.conversation_id == conversation_id)
            .order_by(PausedTurnRow.created_at.asc())
        )
        return result.scalars().all()

    async def exists_for_conversation(self, conversation_id: str) -> bool:
        """Whether the conversation holds ANY durably-paused turn (open-turn probe)."""
        result = await self._session.execute(
            select(PausedTurnRow.message_id)
            .where(PausedTurnRow.conversation_id == conversation_id)
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def delete(self, message_id: str) -> None:
        """Drop a paused turn (live in-process resolve / timeout settled it instead)."""
        await self._session.execute(
            delete(PausedTurnRow).where(PausedTurnRow.message_id == message_id)
        )
        await self._session.commit()

    async def delete_stale(self, *, before: datetime, limit: int) -> int:
        """Delete up to ``limit`` paused turns idle since before ``before`` (TTL sweep).

        ``updated_at`` advances on re-pause (resume → pause again), so an actively
        re-paused turn stays alive while one abandoned past the window is pruned. Also
        clears each pruned turn's ``turn_journal`` rows — the journal-so-far is stored
        there (唯一事实源, §8.3) and would otherwise orphan, since an abandoned pause
        never produces a message to project onto. Batched (one transaction) so a sweep
        never holds one huge lock; returns the number of paused turns removed.
        """
        stale_ids = (
            (
                await self._session.execute(
                    select(PausedTurnRow.message_id)
                    .where(PausedTurnRow.updated_at < before)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        if not stale_ids:
            return 0
        await self._session.execute(
            delete(TurnJournalRow).where(TurnJournalRow.turn_id.in_(stale_ids))
        )
        result = await self._session.execute(
            delete(PausedTurnRow).where(PausedTurnRow.message_id.in_(stale_ids))
        )
        await self._session.commit()
        return result.rowcount or 0


class TurnJournalRepository:
    """The §8.6 ``Journal`` port's Postgres impl — the唯一事实源 store (§8.3).

    A turn's execution facts are stored append-only, ordered by ``seq`` within a
    ``turn_id`` (== the assistant ``message_id``). :meth:`record` replaces the turn's
    rows wholesale (idempotent for a resume that reuses the id); :meth:`load_map`
    batch-loads several turns for the read-time projection (no N+1 when a history
    page renders). Entries are plain ``{kind, payload, ts}`` dicts — the
    ``runs``↔entries transform lives in ``runtime/journal.py`` (the engine domain),
    keeping this layer pure storage.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def record(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        trace_id: str | None,
        entries: Sequence[dict],
    ) -> None:
        """Replace a turn's journal with ``entries`` (delete-then-insert, one commit).

        Replace (not append) so a resume reusing the same ``turn_id`` re-persists the
        full, current fact stream without duplicating the pre-pause prefix. A no-op
        for empty ``entries`` after clearing any stale rows.
        """
        await self._session.execute(delete(TurnJournalRow).where(TurnJournalRow.turn_id == turn_id))
        if entries:
            self._session.add_all(
                [
                    TurnJournalRow(
                        turn_id=turn_id,
                        seq=seq,
                        kind=str(entry.get("kind") or ""),
                        payload=entry.get("payload") or {},
                        ts=entry.get("ts"),
                        conversation_id=conversation_id,
                        trace_id=trace_id,
                    )
                    for seq, entry in enumerate(entries)
                ]
            )
        await self._session.commit()

    async def append(
        self,
        *,
        turn_id: str,
        seq: int | None,
        conversation_id: str,
        trace_id: str | None,
        entry: dict,
    ) -> int | None:
        """Append one journal fact (emit-on-write path, one commit).

        **seq 双模式 (D7)**：
        - ``seq is None`` (live)：事务内 ``pg_advisory_xact_lock(hash(turn_id))`` 后
          ``COALESCE(MAX(seq),-1)+1`` 原子分配——跨 writer 无竞态。禁止无锁 MAX+1。
        - ``seq is int`` (merge / outbox 回写)：显式 seq + ``(turn_id, seq)`` 幂等去重，
          禁止云端重排。

        Returns the durable ``seq`` on fresh insert, or ``None`` on merge-mode duplicate
        no-op (so the SSE barrier can stamp ``id:`` without a second read).
        """
        from sqlalchemy import text

        if seq is None:
            # Live: advisory lock serializes same-turn writers, then allocate.
            # hashtext is stable for a given turn_id within PG.
            await self._session.execute(
                text("SELECT pg_advisory_xact_lock(hashtext(:tid))"),
                {"tid": turn_id},
            )
            result = await self._session.execute(
                text(
                    "SELECT COALESCE(MAX(seq), -1) + 1 FROM turn_journal WHERE turn_id = :tid"
                ),
                {"tid": turn_id},
            )
            allocated = int(result.scalar_one())
            self._session.add(
                TurnJournalRow(
                    turn_id=turn_id,
                    seq=allocated,
                    kind=str(entry.get("kind") or ""),
                    payload=entry.get("payload") or {},
                    ts=entry.get("ts"),
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                )
            )
            await self._session.commit()
            return allocated

        # Merge mode: explicit seq + idempotent conflict.
        stmt = (
            pg_insert(TurnJournalRow)
            .values(
                turn_id=turn_id,
                seq=seq,
                kind=str(entry.get("kind") or ""),
                payload=entry.get("payload") or {},
                ts=entry.get("ts"),
                conversation_id=conversation_id,
                trace_id=trace_id,
            )
            .on_conflict_do_nothing(index_elements=["turn_id", "seq"])
            .returning(TurnJournalRow.turn_id)
        )
        result = await self._session.execute(stmt)
        inserted = result.scalar_one_or_none() is not None
        await self._session.commit()
        return seq if inserted else None

    async def load(self, turn_id: str) -> list[dict]:
        """One turn's facts as ordered ``{kind, payload, ts}`` entries (``[]`` if none)."""
        result = await self._session.execute(
            select(TurnJournalRow)
            .where(TurnJournalRow.turn_id == turn_id)
            .order_by(TurnJournalRow.seq.asc())
        )
        return [{"kind": r.kind, "payload": r.payload, "ts": r.ts} for r in result.scalars().all()]

    async def load_after(self, turn_id: str, after_seq: int) -> list[dict]:
        """Facts with ``seq > after_seq`` as ordered ``{seq, kind, payload, ts}`` (P3 cursor)."""
        result = await self._session.execute(
            select(TurnJournalRow)
            .where(
                TurnJournalRow.turn_id == turn_id,
                TurnJournalRow.seq > after_seq,
            )
            .order_by(TurnJournalRow.seq.asc())
        )
        return [
            {"seq": r.seq, "kind": r.kind, "payload": r.payload, "ts": r.ts}
            for r in result.scalars().all()
        ]

    async def max_seq(self, turn_id: str) -> int | None:
        """Highest journal ``seq`` for ``turn_id``, or ``None`` when the turn has no rows.

        Resume uses this to seed :class:`TurnJournalWriter` past any live append-on-emit
        facts that outran the pause snapshot (sidecar ``journal_entries`` can be shorter
        than the DB), avoiding UniqueViolation on the next append.
        """
        result = await self._session.execute(
            select(func.max(TurnJournalRow.seq)).where(TurnJournalRow.turn_id == turn_id)
        )
        return result.scalar_one_or_none()

    async def load_owned(self, turn_id: str, conversation_id: str) -> list[dict]:
        """One turn's facts, scoped to its conversation (IDOR-safe read).

        Same projection as :meth:`load` but filtered by ``conversation_id`` too, so a
        user who owns conversation A can't read conversation B's journal by passing a
        foreign ``turn_id`` — mirroring the conversation-scoped message delete. A
        cross-tenant pair simply matches no rows (``[]``).
        """
        result = await self._session.execute(
            select(TurnJournalRow)
            .where(
                TurnJournalRow.turn_id == turn_id,
                TurnJournalRow.conversation_id == conversation_id,
            )
            .order_by(TurnJournalRow.seq.asc())
        )
        return [{"kind": r.kind, "payload": r.payload, "ts": r.ts} for r in result.scalars().all()]

    async def load_map(self, turn_ids: Sequence[str]) -> dict[str, list[dict]]:
        """Several turns' facts keyed by ``turn_id`` (ordered entries), batched.

        One query over all ids (ordered by turn_id, seq) grouped in Python, so a
        history page projects every assistant message's replay payload without an
        N+1. Turns with no facts are simply absent from the map.
        """
        ids = list(dict.fromkeys(turn_ids))
        if not ids:
            return {}
        result = await self._session.execute(
            select(TurnJournalRow)
            .where(TurnJournalRow.turn_id.in_(ids))
            .order_by(TurnJournalRow.turn_id.asc(), TurnJournalRow.seq.asc())
        )
        grouped: dict[str, list[dict]] = {}
        for r in result.scalars().all():
            grouped.setdefault(r.turn_id, []).append(
                {"kind": r.kind, "payload": r.payload, "ts": r.ts}
            )
        return grouped


class TurnMetricsRepository:
    """Per-turn 运营观测 telemetry store — the admin 观测看板 data source.

    Writes one compact row per completed assistant turn (:meth:`record`, called
    best-effort at the turn's persistence tail) and serves the dashboard's
    platform-wide rollups: a window's health (:meth:`aggregate_health_for_window`
    — error rate / latency p95 / 委派率), the daily trend
    (:meth:`aggregate_daily_for_window`), and the recent-error feed
    (:meth:`list_recent_errors`). Aggregates are unscoped (every account) — admin
    is a cross-user surface; per-conversation drill-down (会话复盘, P2) joins these
    rows with messages + cost_events by trace_id.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def record(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        user_id: str,
        trace_id: str | None,
        agent_id: str | None,
        kind: str,
        status: str,
        finish_reason: str | None,
        error: str | None,
        rounds: int,
        duration_ms: int,
        delegated: bool,
        workers: int,
        input_tokens: int,
        output_tokens: int,
        boundary_yields: int = 0,
        scope_signals: int = 0,
        revises: int = 0,
        escalations: int = 0,
        audit_drops: int = 0,
    ) -> None:
        """Append one telemetry row for a completed turn (one commit).

        The caller (conversation service) supplies the already-computed turn
        outcome — this layer stays pure storage. A row id is minted here (Core
        bulk paths skip the ORM default, but this is a single ORM ``add``). The
        协作质量 counters (boundary_yields / scope_signals / revises / escalations,
        学·度量 §2.5) default 0 so a plain single-agent turn writes zeros.
        """
        self._session.add(
            TurnMetricsRow(
                id=new_id(),
                turn_id=turn_id,
                conversation_id=conversation_id,
                user_id=user_id,
                trace_id=trace_id,
                agent_id=agent_id,
                kind=kind,
                status=status,
                finish_reason=finish_reason,
                error=error,
                rounds=rounds,
                duration_ms=duration_ms,
                delegated=delegated,
                workers=workers,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                boundary_yields=boundary_yields,
                scope_signals=scope_signals,
                revises=revises,
                escalations=escalations,
                audit_drops=audit_drops,
            )
        )
        await self._session.commit()

    async def aggregate_health_for_window(self, *, since: datetime) -> dict:
        """Platform-wide turn health since a cutoff (admin 观测看板 全站健康).

        One round-trip returns the rollup the dashboard needs: turn count, error
        count (status='error'), delegated count, average + p95 latency, average
        rounds, and token totals. The caller derives the rates (errors/turns,
        delegated/turns) so this layer returns only raw aggregates. p95 uses
        Postgres ``percentile_cont`` (NULL → 0 on an empty window). Filters on
        ``ix_turn_metrics_created``.
        """
        err = case((TurnMetricsRow.status == "error", 1), else_=0)
        dele = case((TurnMetricsRow.delegated.is_(True), 1), else_=0)
        # 协作质量 (学·度量 §2.5): 首计划存活 = delegated turns whose first plan ran without a
        # supervised boundary handing control back (boundary_yields == 0). The caller derives
        # 存活率 = survived / delegated; the raw counters back 返工/漂移/escalation rates.
        survived = case(
            (and_(TurnMetricsRow.delegated.is_(True), TurnMetricsRow.boundary_yields == 0), 1),
            else_=0,
        )
        stmt = select(
            func.count().label("turns"),
            func.coalesce(func.sum(err), 0).label("errors"),
            func.coalesce(func.sum(dele), 0).label("delegated"),
            func.coalesce(func.avg(TurnMetricsRow.duration_ms), 0).label("avg_duration"),
            func.percentile_cont(0.95)
            .within_group(TurnMetricsRow.duration_ms.asc())
            .label("p95_duration"),
            func.coalesce(func.avg(TurnMetricsRow.rounds), 0).label("avg_rounds"),
            func.coalesce(func.sum(TurnMetricsRow.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(TurnMetricsRow.output_tokens), 0).label("output_tokens"),
            func.coalesce(func.sum(survived), 0).label("first_plan_survived"),
            func.coalesce(func.sum(TurnMetricsRow.boundary_yields), 0).label("boundary_yields"),
            func.coalesce(func.sum(TurnMetricsRow.scope_signals), 0).label("scope_signals"),
            func.coalesce(func.sum(TurnMetricsRow.revises), 0).label("revises"),
            func.coalesce(func.sum(TurnMetricsRow.escalations), 0).label("escalations"),
        ).where(TurnMetricsRow.created_at >= since)
        row = (await self._session.execute(stmt)).one()
        return {
            "turns": int(row.turns or 0),
            "errors": int(row.errors or 0),
            "delegated": int(row.delegated or 0),
            "avg_duration_ms": int(row.avg_duration or 0),
            "p95_duration_ms": int(row.p95_duration or 0),
            "avg_rounds": float(row.avg_rounds or 0.0),
            "input_tokens": int(row.input_tokens or 0),
            "output_tokens": int(row.output_tokens or 0),
            # 协作质量 raw aggregates (caller derives rates over delegated/turns).
            "first_plan_survived": int(row.first_plan_survived or 0),
            "boundary_yields": int(row.boundary_yields or 0),
            "scope_signals": int(row.scope_signals or 0),
            "revises": int(row.revises or 0),
            "escalations": int(row.escalations or 0),
        }

    async def aggregate_daily_for_window(self, *, since: datetime) -> dict[str, dict]:
        """Daily turn/error counts (UTC days) since a cutoff — the dashboard trend.

        Groups the window into UTC calendar days (matching the cost trend's day
        boundaries) and returns an ``{iso_date: {turns, errors}}`` map (only days
        with rows); the caller zero-fills absent days for a fixed-length series.
        """
        day = func.date_trunc("day", func.timezone("UTC", TurnMetricsRow.created_at))
        err = case((TurnMetricsRow.status == "error", 1), else_=0)
        stmt = (
            select(
                day.label("day"),
                func.count().label("turns"),
                func.coalesce(func.sum(err), 0).label("errors"),
            )
            .where(TurnMetricsRow.created_at >= since)
            .group_by(day)
        )
        rows = (await self._session.execute(stmt)).all()
        return {
            row.day.date().isoformat(): {
                "turns": int(row.turns or 0),
                "errors": int(row.errors or 0),
            }
            for row in rows
        }

    async def list_recent_errors(self, *, limit: int = 20) -> Sequence[TurnMetricsRow]:
        """The most recent errored turns (status='error'), newest-first.

        The dashboard's「近期错误」feed and the entry point for 会话复盘 — each row
        carries the trace_id/conversation_id to drill from a failure into its full
        turn. Capped at ``limit`` (the long tail isn't actionable on a dashboard).
        """
        result = await self._session.execute(
            select(TurnMetricsRow)
            .where(TurnMetricsRow.status == "error")
            .order_by(TurnMetricsRow.created_at.desc())
            .limit(limit)
        )
        return result.scalars().all()

    async def list_for_conversation(self, conversation_id: str) -> Sequence[TurnMetricsRow]:
        """Every turn's telemetry for one conversation, oldest-first (会话复盘).

        The 复盘 timeline joins these to the conversation's messages by ``trace_id``;
        oldest-first matches the message thread's chronological order. Hits
        ``ix_turn_metrics_conversation_created``.
        """
        result = await self._session.execute(
            select(TurnMetricsRow)
            .where(TurnMetricsRow.conversation_id == conversation_id)
            .order_by(TurnMetricsRow.created_at.asc())
        )
        return result.scalars().all()

    async def list_recent_for_user(
        self, user_id: str, *, limit: int = 20
    ) -> Sequence[TurnMetricsRow]:
        """The most recent turns for one account (用户详情下钻 最近活动), newest-first.

        The per-user counterpart of :meth:`list_recent_errors` — every turn (ok +
        error), capped at ``limit``, so the operator sees an account's latest
        activity and can drill any row into 会话复盘. Filters on ``user_id``; the
        ``ix_turn_metrics_created`` index serves the newest-first ordering (a
        bounded recent-N read, so a dedicated user index isn't warranted yet).
        """
        result = await self._session.execute(
            select(TurnMetricsRow)
            .where(TurnMetricsRow.user_id == user_id)
            .order_by(TurnMetricsRow.created_at.desc())
            .limit(limit)
        )
        return result.scalars().all()

    async def aggregate_stats_by_conversations(
        self, conversation_ids: Sequence[str]
    ) -> dict[str, dict[str, int]]:
        """Turn + error counts per conversation (admin roster enrichment).

        One GROUP BY over the given ids. Ids with no telemetry are absent
        (callers default turns/errors to 0).
        """
        if not conversation_ids:
            return {}
        err = func.sum(case((TurnMetricsRow.status == "error", 1), else_=0))
        stmt = (
            select(
                TurnMetricsRow.conversation_id.label("conversation_id"),
                func.count().label("turns"),
                err.label("errors"),
            )
            .where(TurnMetricsRow.conversation_id.in_(conversation_ids))
            .group_by(TurnMetricsRow.conversation_id)
        )
        rows = (await self._session.execute(stmt)).all()
        return {
            row.conversation_id: {"turns": int(row.turns), "errors": int(row.errors)}
            for row in rows
        }

    async def list_platform(
        self,
        *,
        page: int = 1,
        page_size: int = 50,
        user_id: str | None = None,
        conversation_id: str | None = None,
        status: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        include_deleted_conversations: bool = True,
    ) -> tuple[Sequence[tuple[TurnMetricsRow, Conversation, User | None]], int]:
        """Paginated cross-user turn feed for the admin 对话 page (newest-first).

        Joins conversation + owner for list context. Hidden handoff-host
        conversations are always excluded; ``include_deleted_conversations``
        controls soft-deleted chats.
        """
        base = (
            select(TurnMetricsRow, Conversation, User)
            .join(Conversation, Conversation.id == TurnMetricsRow.conversation_id)
            .outerjoin(User, User.user_id == TurnMetricsRow.user_id)
            .where(Conversation.mode != "handoff")
        )
        if not include_deleted_conversations:
            base = base.where(Conversation.deleted_at.is_(None))
        if user_id is not None:
            base = base.where(TurnMetricsRow.user_id == user_id)
        if conversation_id is not None:
            base = base.where(TurnMetricsRow.conversation_id == conversation_id)
        if status is not None:
            base = base.where(TurnMetricsRow.status == status)
        if since is not None:
            base = base.where(TurnMetricsRow.created_at >= since)
        if until is not None:
            base = base.where(TurnMetricsRow.created_at <= until)

        count_result = await self._session.execute(
            select(func.count()).select_from(base.subquery())
        )
        total = count_result.scalar_one()

        offset = (page - 1) * page_size
        result = await self._session.execute(
            base.order_by(TurnMetricsRow.created_at.desc())
            .limit(page_size)
            .offset(offset)
        )
        return result.all(), total

    async def aggregate_audit_drops_for_window(self, *, since: datetime) -> int:
        """Sum of per-turn audit write degradations since a cutoff."""
        stmt = select(func.coalesce(func.sum(TurnMetricsRow.audit_drops), 0)).where(
            TurnMetricsRow.created_at >= since
        )
        return int((await self._session.execute(stmt)).scalar_one() or 0)

    async def count_distinct_users_for_window(self, *, since: datetime) -> int:
        """Distinct accounts that completed ≥1 turn since a cutoff (活跃用户).

        The 概览 dashboard's「今日活跃」metric — ``COUNT(DISTINCT user_id)`` over
        ``turn_metrics`` in the window (a user who took a turn is "active"). Filters
        on ``ix_turn_metrics_created``.
        """
        stmt = select(func.count(distinct(TurnMetricsRow.user_id))).where(
            TurnMetricsRow.created_at >= since
        )
        return int((await self._session.execute(stmt)).scalar_one() or 0)
