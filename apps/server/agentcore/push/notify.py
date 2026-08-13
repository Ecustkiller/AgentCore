"""User-level push orchestration (原生推送下发, 认证与会话 §十).

:func:`notify_user` is the single best-effort entry the attention triggers call: it
resolves a user's device tokens, hands them to the configured :class:`PushSender`,
prunes any the provider reports stale, and answers how many devices actually took the
notification. It NEVER raises into the caller — a failed push is a missed convenience,
never a broken turn.

Uses ``async_session_factory`` directly (not a request session), matching the
suspension / cost-ledger persistence posture (the triggers run inside the turn pipeline,
outside any HTTP request).
"""

from __future__ import annotations

from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import PushDeviceRepository
from agentcore.push.sender import NullPushSender, PushNotification, build_push_sender

logger = get_logger(__name__)


async def notify_user(user_id: str, notification: PushNotification) -> int:
    """Push ``notification`` to all of ``user_id``'s registered devices (best-effort).

    Returns how many devices the provider ACCEPTED — ``0`` means nothing left the
    process, whatever the reason (push unconfigured, no registered device, credentials
    that never minted a bearer, every token dead). Callers report that number instead of
    「我调用了 notify_user」, which is true even when push is off and therefore worthless
    during a 真机 bring-up.

    Every zero-delivery path also emits one line saying WHICH zero it was
    (``push.skipped`` here, ``push.fcm_*`` in the sender), because the expensive
    ambiguity on a real device is「压根没发」vs「发了但没到」.

    Fast-paths to a no-op when push is disabled (the default) BEFORE touching the DB, so
    wiring this into a hot trigger costs nothing until FCM is configured. Stale tokens
    the provider rejects are pruned so a dead device stops being retried.
    """
    sender = build_push_sender()
    if isinstance(sender, NullPushSender):
        # Which flavour (disabled / no path / bad credential file) is on the one-shot
        # ``push.fcm_*`` line ``build_push_sender`` logged when it chose this sender.
        logger.info("push.skipped", user_id=user_id, reason="unconfigured")
        return 0
    try:
        async with async_session_factory() as db:
            repo = PushDeviceRepository(db)
            tokens = await repo.tokens_for_user(user_id)
            if not tokens:
                logger.info("push.skipped", user_id=user_id, reason="no_devices")
                return 0
            result = await sender.send(tokens, notification)
            if result.stale:
                await repo.delete_tokens(result.stale)
            logger.info(
                "push.notified",
                user_id=user_id,
                devices=len(tokens),
                accepted=result.accepted,
                pruned=len(result.stale),
                failed=result.failed,
            )
            return result.accepted
    except Exception as e:  # noqa: BLE001 — a push must never break the turn that triggered it
        logger.warning("push.notify_failed", user_id=user_id, error=str(e))
        return 0
