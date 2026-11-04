"""Persistence and scheduling for per-model probes (``llm_model_health``).

``llm/model_health.py`` decides *what* a probe answer means and *whether* a model
is worth asking again; it is deliberately DB-free, because ``agentcore.llm`` is
the outbound gateway and ``tests/test_arch_boundaries.py`` keeps it that way.
Everything that needs a session — loading the user's profiles, reading the last
verdicts, writing new ones, sweeping every configured endpoint on a schedule —
lives here instead, so the coupling is one bridge module instead of an exemption
sprinkled through the gateway.

The split also happens to be the seam worth testing: the classification, the
freshness window and the free-pool hold are pure functions over plain data, and
they are pinned in ``tests/test_llm_model_health.py`` without a database.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agentcore.config.settings import settings
from agentcore.core.logging import get_logger
from agentcore.db.models import LlmModelHealth, LlmModelProfile, UserLlmProvider
from agentcore.llm.model_health import (
    STATUS_DEAD,
    ProbeOutcome,
    RecordedVerdict,
    _models_to_probe,
    probe_models,
)

logger = get_logger(__name__)


async def health_for_user(
    session, user_id: str
) -> dict[tuple[str, str], LlmModelHealth]:
    """Last verdicts for one user, keyed by (provider_id, model_id)."""
    rows = await session.execute(
        select(LlmModelHealth).where(LlmModelHealth.user_id == user_id)
    )
    return {(row.provider_id, row.model_id): row for row in rows.scalars().all()}


async def _load_profiles(session, user_id: str) -> list[LlmModelProfile]:
    rows = await session.execute(
        select(LlmModelProfile).where(LlmModelProfile.user_id == user_id)
    )
    return list(rows.scalars().all())


async def _recorded_for(
    session, *, user_id: str, provider_id: str
) -> dict[str, RecordedVerdict]:
    rows = await session.execute(
        select(LlmModelHealth).where(
            LlmModelHealth.user_id == user_id,
            LlmModelHealth.provider_id == provider_id,
        )
    )
    return {
        row.model_id: RecordedVerdict(
            status=row.status, detail=row.detail, checked_at=row.checked_at
        )
        for row in rows.scalars().all()
    }


async def _upsert(
    session,
    *,
    user_id: str,
    provider_id: str,
    model_id: str,
    outcome: ProbeOutcome,
) -> None:
    stmt = pg_insert(LlmModelHealth).values(
        user_id=user_id,
        provider_id=provider_id,
        model_id=model_id,
        status=outcome.status,
        detail=outcome.detail,
        latency_ms=outcome.latency_ms,
        checked_at=datetime.now(UTC),
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_llm_model_health_target",
        set_={
            "status": stmt.excluded.status,
            "detail": stmt.excluded.detail,
            "latency_ms": stmt.excluded.latency_ms,
            "checked_at": stmt.excluded.checked_at,
        },
    )
    await session.execute(stmt)


async def probe_provider(
    session,
    *,
    row: UserLlmProvider,
    api_key: str,
    max_models: int | None = None,
    force: bool = False,
) -> dict[str, ProbeOutcome]:
    """Probe one endpoint's plausible ids and persist the verdicts."""
    profiles = await _load_profiles(session, row.user_id)
    models = _models_to_probe(
        profiles=profiles, provider_id=row.id, base_url=row.base_url
    )
    cap = (
        settings.llm_model_health_probe_max_models if max_models is None else max_models
    )
    if cap and len(models) > cap:
        models = models[:cap]
    if not models:
        return {}

    recorded = await _recorded_for(session, user_id=row.user_id, provider_id=row.id)
    batch = await probe_models(
        base_url=row.base_url,
        api_key=api_key,
        models=models,
        recorded=recorded,
        force=force,
    )

    for model_id, outcome in batch.results.items():
        await _upsert(
            session,
            user_id=row.user_id,
            provider_id=row.id,
            model_id=model_id,
            outcome=outcome,
        )
    await session.commit()
    logger.info(
        "llm.model_probe_done",
        user_id=row.user_id,
        provider_id=row.id,
        # ``probed`` counts requests actually spent; held ids are reported but
        # never asked, and conflating the two would hide the saving.
        probed=len(batch.results) - len(batch.held),
        held=len(batch.held),
        dead=sum(1 for o in batch.results.values() if o.status == STATUS_DEAD),
    )
    return batch.results


async def probe_all_users(max_models: int | None = None) -> int:
    """One sweep over every configured BYOK endpoint. Returns ids reported."""
    from agentcore.llm.resolve import _encryptor

    enc = _encryptor()
    if enc is None:
        logger.info("llm.model_probe_skipped", reason="no_encryption_key")
        return 0
    from agentcore.db import async_session_factory

    total = 0
    async with async_session_factory() as session:
        rows = list((await session.execute(select(UserLlmProvider))).scalars().all())
        for row in rows:
            if not row.api_key_enc:
                continue
            try:
                api_key = enc.decrypt(row.api_key_enc).decode()
            except Exception:  # noqa: BLE001 — one bad cipher must not stop the sweep
                logger.warning("llm.model_probe_decrypt_failed", provider_id=row.id)
                continue
            try:
                results = await probe_provider(
                    session, row=row, api_key=api_key, max_models=max_models
                )
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — one endpoint must not stop the sweep
                logger.warning(
                    "llm.model_probe_failed", provider_id=row.id, exc_info=True
                )
                # The shared session may hold a failed statement; clear it so the
                # next provider is not silently skipped by a poisoned transaction.
                await session.rollback()
                continue
            total += len(results)
    return total


async def model_health_loop() -> None:
    """Probe configured endpoints forever on the configured interval."""
    interval = settings.llm_model_health_probe_interval_seconds
    while True:
        try:
            await probe_all_users()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a failed sweep must not kill the loop
            logger.warning("llm.model_probe_sweep_failed", error=str(e))
        await asyncio.sleep(interval)
