import { logEvent } from "@/lib/log";
import { ApiError, NetworkError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";

/** Result envelope posted as `ResolveClientToolInteraction` (sans `kind`). */
export type ClientToolResultEnvelope =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { kind: string; detail: string; [key: string]: unknown };
    };

type FulfilledEntry = {
  result: ClientToolResultEnvelope;
  resolved: boolean;
  resolveGate: Promise<void> | null;
};

/** In-flight perform+resolve for a request_id (join waiters). */
const inFlight = new Map<string, Promise<void>>();

/** Successfully performed side effects — skip re-run; may still resolve. */
const fulfilled = new Map<string, FulfilledEntry>();

/** Fulfill 在飞按 conversation（仅观测；不改调度）。 */
let fulfillInflightTotal = 0;
const fulfillInflightByCid = new Map<string, number>();

/** In-process settle retries before giving up (dogfood: single NetworkError → sticky). */
const RESOLVE_MAX_ATTEMPTS = 3;

function fulfillSnapshot(conversationId: string): {
  inflight_total: number;
  inflight_cid: number;
  queue_depth: number;
} {
  return {
    inflight_total: fulfillInflightTotal,
    inflight_cid: fulfillInflightByCid.get(conversationId) ?? 0,
    queue_depth: Math.max(0, fulfillInflightTotal - 1),
  };
}

function enterFulfill(conversationId: string): {
  inflight_total: number;
  inflight_cid: number;
  queue_depth: number;
} {
  const queueDepth = fulfillInflightTotal;
  fulfillInflightTotal += 1;
  fulfillInflightByCid.set(
    conversationId,
    (fulfillInflightByCid.get(conversationId) ?? 0) + 1,
  );
  return {
    inflight_total: fulfillInflightTotal,
    inflight_cid: fulfillInflightByCid.get(conversationId) ?? 0,
    queue_depth: queueDepth,
  };
}

function leaveFulfill(conversationId: string): void {
  fulfillInflightTotal = Math.max(0, fulfillInflightTotal - 1);
  const n = (fulfillInflightByCid.get(conversationId) ?? 1) - 1;
  if (n <= 0) fulfillInflightByCid.delete(conversationId);
  else fulfillInflightByCid.set(conversationId, n);
}

/** Test-only: clear process-local fulfillment state. */
export function resetClientToolFulfillmentForTests(): void {
  inFlight.clear();
  fulfilled.clear();
  fulfillInflightTotal = 0;
  fulfillInflightByCid.clear();
}

function logWorkspaceResolve(
  conversationId: string,
  requestId: string,
  logLabel: string,
  outcome: "ok" | "stale_404" | "fail",
  extra?: Record<string, unknown>,
): void {
  // 仅本地工作区通道需要 L3 分型；其它 client_tool 保持安静。
  if (logLabel !== "workspaceOps") return;
  const level =
    outcome === "ok" ? "debug" : outcome === "fail" ? "error" : "info";
  logEvent(level, "workspace_op.resolve", {
    conversation_id: conversationId,
    request_id: requestId,
    outcome,
    ...fulfillSnapshot(conversationId),
    ...extra,
  });
}

function isTransientResolveError(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof ApiError && (err.status >= 500 || err.status === 429)) {
    return true;
  }
  return false;
}

function resolveBackoffMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * After settle retries are exhausted on the cloud bridge, kick the live SSE
 * pump into the same transport-drop path as ``sse.idle_stall`` so the turn
 * rejoins and later ``workspace_op_required`` frames are not stranded.
 */
async function nudgeStreamAfterSettleExhausted(
  conversationId: string,
  requestId: string,
): Promise<void> {
  try {
    const { forceSseTransportDrop } = await import(
      "@/services/streamConversation"
    );
    const nudged = forceSseTransportDrop(conversationId);
    logEvent("warn", "workspace_op.settle_exhausted", {
      conversation_id: conversationId,
      request_id: requestId,
      stream_nudged: nudged,
      ...fulfillSnapshot(conversationId),
    });
  } catch {
    logEvent("warn", "workspace_op.settle_exhausted", {
      conversation_id: conversationId,
      request_id: requestId,
      stream_nudged: false,
      ...fulfillSnapshot(conversationId),
    });
  }
}

async function tryResolve(
  conversationId: string,
  requestId: string,
  result: ClientToolResultEnvelope,
  logLabel: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {
  const isWorkspace = logLabel === "workspaceOps";
  const resolveStarted = Date.now();
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < RESOLVE_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      await resolveInteraction(conversationId, requestId, {
        kind: "client_tool",
        ...result,
      });
      logWorkspaceResolve(conversationId, requestId, logLabel, "ok", {
        result_ok: result.ok,
        resolve_attempts: attempt,
        resolve_ms: Date.now() - resolveStarted,
        ...extra,
      });
      return true;
    } catch (err) {
      lastErr = err;
      if (err instanceof ApiError && err.status === 404) {
        logWorkspaceResolve(conversationId, requestId, logLabel, "stale_404", {
          resolve_attempts: attempt,
          resolve_ms: Date.now() - resolveStarted,
          ...extra,
        });
        return true; // stale — no-op
      }
      const retryable =
        isTransientResolveError(err) && attempt < RESOLVE_MAX_ATTEMPTS;
      if (retryable) {
        if (isWorkspace) {
          logEvent("warn", "workspace_op.resolve_retry", {
            conversation_id: conversationId,
            request_id: requestId,
            attempt,
            max_attempts: RESOLVE_MAX_ATTEMPTS,
            error_name: err instanceof Error ? err.name : "unknown",
            http_status: err instanceof ApiError ? err.status : null,
            ...fulfillSnapshot(conversationId),
          });
        }
        await sleep(resolveBackoffMs(attempt));
        continue;
      }
      break;
    }
  }

  const httpStatus = lastErr instanceof ApiError ? lastErr.status : null;
  logWorkspaceResolve(conversationId, requestId, logLabel, "fail", {
    http_status: httpStatus,
    error_name: lastErr instanceof Error ? lastErr.name : "unknown",
    resolve_attempts: attempt,
    resolve_ms: Date.now() - resolveStarted,
    ...extra,
  });
  console.error(`[${logLabel}] 回填失败`, lastErr);
  if (isWorkspace) {
    void nudgeStreamAfterSettleExhausted(conversationId, requestId);
  }
  return false;
}

/**
 * Desktop client_tool fulfillment gate (attach rehang safety).
 *
 * Same `request_id` already in-flight or successfully fulfilled in this process →
 * skip the side effect. Still retries resolve when the first settle has not landed.
 * Failed side effects are not cached, so a later delivery may re-perform.
 */
export async function fulfillClientToolOnce(opts: {
  requestId: string;
  conversationId: string;
  logLabel: string;
  perform: () => Promise<ClientToolResultEnvelope>;
}): Promise<void> {
  const { requestId, conversationId, logLabel, perform } = opts;
  const isWorkspace = logLabel === "workspaceOps";

  const pending = inFlight.get(requestId);
  if (pending) {
    if (isWorkspace) {
      logEvent("info", "workspace_op.fulfill_join", {
        conversation_id: conversationId,
        request_id: requestId,
        ...fulfillSnapshot(conversationId),
      });
    }
    await pending;
  }

  const cached = fulfilled.get(requestId);
  if (cached) {
    if (cached.resolved) return;
    if (cached.resolveGate) {
      await cached.resolveGate;
      return;
    }
    const gate = (async () => {
      cached.resolved = await tryResolve(
        conversationId,
        requestId,
        cached.result,
        logLabel,
      );
    })();
    cached.resolveGate = gate;
    try {
      await gate;
    } finally {
      cached.resolveGate = null;
    }
    return;
  }

  if (inFlight.has(requestId)) {
    await inFlight.get(requestId);
    return fulfillClientToolOnce(opts);
  }

  const t0 = Date.now();
  const enter = isWorkspace ? enterFulfill(conversationId) : null;
  if (isWorkspace && enter) {
    logEvent("debug", "workspace_op.fulfill_begin", {
      conversation_id: conversationId,
      request_id: requestId,
      ...enter,
    });
  }

  const run = (async () => {
    try {
      const result = await perform();
      if (result.ok) {
        fulfilled.set(requestId, {
          result,
          resolved: false,
          resolveGate: null,
        });
      }
      const settled = await tryResolve(
        conversationId,
        requestId,
        result,
        logLabel,
        isWorkspace
          ? {
              duration_ms: Date.now() - t0,
              result_ok: result.ok,
            }
          : undefined,
      );
      if (result.ok) {
        const entry = fulfilled.get(requestId);
        if (entry) entry.resolved = settled;
      }
    } finally {
      if (isWorkspace) leaveFulfill(conversationId);
    }
  })();

  inFlight.set(requestId, run);
  try {
    await run;
  } finally {
    inFlight.delete(requestId);
  }
}
