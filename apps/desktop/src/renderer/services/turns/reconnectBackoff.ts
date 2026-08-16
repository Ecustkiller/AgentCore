/**
 * Shared reconnect backoff — conversation-level follow and turn-level rejoin
 * use the same 1s → 30s exponential schedule. Do not invent a second curve.
 */

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_JITTER_MS = 500;

/**
 * Delay before the next reconnect attempt.
 *
 * ``attempts`` is the number of failures already observed (0 after the first
 * drop → 1s). Caps at {@link RECONNECT_MAX_MS}. ``jitter`` defaults to
 * ``Math.random()`` so callers can pin it in tests.
 */
export function reconnectBackoffMs(
  attempts: number,
  jitter: number = Math.random(),
): number {
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  const unit = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 1) : 0;
  return delay + unit * RECONNECT_JITTER_MS;
}
