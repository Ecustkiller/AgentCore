/**
 * Outbox writeback — drain loop, flushTurn, polling, IPC.
 */
import {
  OUTBOX_CHANNELS,
  type OutboxFlushTurnResult,
  type OutboxPendingEntry,
  type OutboxStatusSnapshot,
  type OutboxSyncedPayload,
} from "@shared/outbox-contract";
import { BrowserWindow, app, ipcMain } from "electron";
import {
  bearerPostJson,
  persistAuthCookies,
  refreshAccessToken,
} from "../auth-client";
import {
  abortLocalTurnPlaceholder,
  checkpointOpenRecord,
  markLocalTurnSettled,
  startOutboxProjectionWatch,
  stopOutboxProjectionWatch,
  withUmidLock,
} from "./projection";
import {
  EMPTY_USER_MESSAGE_PLACEHOLDER,
  type OutboxRecord,
  PHASE_OPEN,
  PHASE_READY,
  computeBackoffDelayMs,
  deleteRecord,
  fillEmptyUserMessageForWriteback,
  fillFromCaptainStreamSegments,
  isPermanentHttpFailure,
  isSafeOutboxId,
  readOutboxRecord,
  readOutboxRecords,
  shouldDeleteOutboxAfterAck,
  shouldSalvageOpenRecord,
  toRecordTurnBody,
  writeRecord,
} from "./strategy";
import { moveToDeadLetter, readDeadLetterRecords } from "./unsynced";

function pushSynced(payload: OutboxSyncedPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(OUTBOX_CHANNELS.synced, payload);
    }
  }
}

async function recordTransientFailure(record: OutboxRecord): Promise<void> {
  const count = (record.retry_count ?? 0) + 1;
  record.retry_count = count;
  record.next_attempt_at = Date.now() + computeBackoffDelayMs(count);
  try {
    await writeRecord(record);
  } catch (err) {
    console.error(
      "[outbox] retry state write failed",
      record.user_message_id,
      err,
    );
  }
}

/** Recent successful writebacks — fills synthetic flushTurn ack when the file is already gone. */
const recentSyncedConversation = new Map<string, string>();

/**
 * Live conversation ids (sidecar ``this.turns``). Unscoped salvage must skip
 * these — OPEN files belong to a turn that is still writing.
 */
let occupiedConversationIdsProvider: () => readonly string[] = () => [];

export function setOccupiedConversationIdsProvider(
  fn: () => readonly string[],
): void {
  occupiedConversationIdsProvider = fn;
}

export function resetOccupiedConversationIdsProviderForTests(): void {
  occupiedConversationIdsProvider = () => [];
}

function occupiedConversationIdSet(): Set<string> {
  const ids = new Set<string>();
  for (const id of occupiedConversationIdsProvider()) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}

export type RecoverLocalPersistenceOpts = {
  /** Only these conversations (dead sidecar). Occupied skip does not apply. */
  conversationIds?: readonly string[];
  /** Only these outbox files (failed occupy). Occupied skip does not apply. */
  userMessageIds?: readonly string[];
  /**
   * When promoting OPEN: found-dead default is ``interrupted``. Occupied RPC
   * stop ownership passes ``cancelled`` / ``interrupted`` / ``error``.
   */
  salvageFinishReason?: "interrupted" | "error" | "cancelled";
  /** Observed RPC error text when ``salvageFinishReason`` is ``error``. */
  salvageErrorMessage?: string;
};

function inScopeForOpenSalvage(
  record: OutboxRecord,
  opts: {
    salvageOpen: boolean;
    conversationIds?: ReadonlySet<string>;
    userMessageIds?: ReadonlySet<string>;
  },
): boolean {
  if (!opts.salvageOpen || record.phase !== PHASE_OPEN) return false;
  if (opts.userMessageIds) {
    return opts.userMessageIds.has(record.user_message_id);
  }
  if (opts.conversationIds) {
    return opts.conversationIds.has(record.conversation_id);
  }
  return !occupiedConversationIdSet().has(record.conversation_id);
}

async function processOneOutboxRecord(
  record: OutboxRecord,
  opts: {
    salvageOpen: boolean;
    bypassBackoff: boolean;
    conversationIds?: ReadonlySet<string>;
    userMessageIds?: ReadonlySet<string>;
    salvageFinishReason?: "interrupted" | "error" | "cancelled";
    salvageErrorMessage?: string;
  },
): Promise<OutboxSyncedPayload | null> {
  const bypassBackoff = opts.bypassBackoff;
  if (inScopeForOpenSalvage(record, opts)) {
    if (shouldSalvageOpenRecord(record)) {
      record.phase = PHASE_READY;
      record.finish_reason =
        record.finish_reason || opts.salvageFinishReason || "interrupted";
      if (
        record.finish_reason === "error" &&
        (opts.salvageErrorMessage || "").trim()
      ) {
        const prior =
          record.runs &&
          typeof record.runs === "object" &&
          !Array.isArray(record.runs)
            ? (record.runs as Record<string, unknown>)
            : {};
        if (prior.error == null) {
          record.runs = {
            ...prior,
            finish_reason: "error",
            error: {
              code: "PIPELINE_ERROR",
              message: (opts.salvageErrorMessage ?? "").trim().slice(0, 2000),
            },
          };
        }
      }
      try {
        await writeRecord(record);
      } catch (err) {
        console.error("[outbox] salvage promote failed", err);
        return null;
      }
    } else {
      console.warn("[outbox] discard empty open shell", record.user_message_id);
      await abortLocalTurnPlaceholder({
        conversationId: record.conversation_id,
        userMessageId: record.user_message_id,
        messageId: (record.message_id || "").trim(),
      });
      await deleteRecord(record.user_message_id);
      return null;
    }
  }
  if (record.phase === PHASE_OPEN) {
    await checkpointOpenRecord(record);
    return null;
  }
  if (record.phase !== PHASE_READY) return null;
  if (
    !(record.user_message || "").trim() ||
    (record.user_message || "").trim() === EMPTY_USER_MESSAGE_PLACEHOLDER
  ) {
    if (fillEmptyUserMessageForWriteback(record)) {
      console.warn(
        "[outbox] empty user_message → writeback without user bubble",
        record.user_message_id,
        record.message_id ?? null,
        {
          hasJournal: !!(
            record.journal &&
            typeof record.journal === "object" &&
            Object.keys(record.journal).length > 0
          ),
          hasRuns: !!(
            record.runs &&
            typeof record.runs === "object" &&
            Object.keys(record.runs as object).length > 0
          ),
        },
      );
      try {
        await writeRecord(record);
      } catch (err) {
        console.error(
          "[outbox] empty user_message normalize persist failed",
          record.user_message_id,
          err,
        );
      }
    } else {
      console.error(
        "[outbox] skip empty user_message (not postable) → dead-letter",
        record.user_message_id,
        record.message_id ?? null,
      );
      await moveToDeadLetter(record, 0);
      return null;
    }
  }
  if (
    !(record.trace_id || "").trim() ||
    (record.trace_id || "").length !== 32
  ) {
    console.warn(
      "[outbox] skip invalid trace_id",
      record.user_message_id,
      record.trace_id ?? null,
    );
    return null;
  }
  if (
    !bypassBackoff &&
    typeof record.next_attempt_at === "number" &&
    record.next_attempt_at > Date.now()
  ) {
    return null;
  }

  fillFromCaptainStreamSegments(record);

  if (
    !isSafeOutboxId(record.user_message_id) ||
    !isSafeOutboxId(record.conversation_id)
  ) {
    console.error(
      "[outbox] skipping unsafe id",
      record.user_message_id,
      record.conversation_id,
    );
    return null;
  }

  const path = `/v1/conversations/${encodeURIComponent(record.conversation_id)}/local-turns`;
  let result: { ok: boolean; status: number; body: unknown };
  try {
    result = await bearerPostJson(path, toRecordTurnBody(record));
  } catch (err) {
    console.error(
      "[outbox] writeback network error",
      record.user_message_id,
      err,
    );
    await recordTransientFailure(record);
    return null;
  }
  if (!result.ok) {
    console.error(
      "[outbox] writeback failed",
      record.user_message_id,
      result.status,
      result.body,
    );
    if (isPermanentHttpFailure(result.status)) {
      await moveToDeadLetter(record, result.status);
    } else {
      await recordTransientFailure(record);
    }
    return null;
  }
  const body = result.body as {
    user_message_id?: string;
    assistant_message_id?: string | null;
    title?: string | null;
    noop?: boolean | null;
  };
  if (!shouldDeleteOutboxAfterAck(body, record)) {
    console.error(
      "[outbox] false ack (null assistant + process) → dead-letter",
      record.user_message_id,
      body,
    );
    await moveToDeadLetter(record, result.status || 200);
    return null;
  }
  const payload: OutboxSyncedPayload = {
    conversationId: record.conversation_id,
    userMessageId: record.user_message_id,
    cloudUserMessageId: body.user_message_id || record.user_message_id,
    assistantMessageId: body.assistant_message_id ?? null,
    title: body.title ?? null,
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.harvest_kind ? { harvestKind: record.harvest_kind } : {}),
  };
  markLocalTurnSettled(record.user_message_id);
  await deleteRecord(record.user_message_id);
  recentSyncedConversation.set(record.user_message_id, record.conversation_id);
  pushSynced(payload);
  return payload;
}

let drainInFlight: Promise<{
  status: OutboxStatusSnapshot;
  synced: OutboxSyncedPayload[];
}> | null = null;

/**
 * At-least-once drain of ready outbox records. Idempotent cloud side
 * (`user_message_id`); retries leave the file until ack.
 */
export async function drainOutbox(): Promise<OutboxStatusSnapshot> {
  const result = await drainOutboxDetailed();
  return result.status;
}

async function drainOutboxDetailed(opts?: {
  /**
   * Promote abandoned OPEN records. Unscoped = app start / unknown dead engine:
   * skip conversations that are still writing. Scoped allowlists (dead sidecar /
   * failed occupy) bypass that skip for those ids only.
   */
  salvageOpen?: boolean;
  /** User-initiated flushTurn: ignore next_attempt_at and try immediately. */
  bypassBackoff?: boolean;
  conversationIds?: readonly string[];
  userMessageIds?: readonly string[];
  salvageFinishReason?: "interrupted" | "error" | "cancelled";
  salvageErrorMessage?: string;
}): Promise<{
  status: OutboxStatusSnapshot;
  synced: OutboxSyncedPayload[];
}> {
  const salvageOpen = opts?.salvageOpen === true;
  const bypassBackoff = opts?.bypassBackoff === true;
  const salvageFinishReason = opts?.salvageFinishReason;
  const salvageErrorMessage = opts?.salvageErrorMessage;
  const conversationIds = opts?.conversationIds
    ? new Set(opts.conversationIds)
    : undefined;
  const userMessageIds = opts?.userMessageIds
    ? new Set(opts.userMessageIds)
    : undefined;
  // Coalesce regular polls only; salvage / flushTurn wait then run their own pass.
  if (drainInFlight) {
    if (!salvageOpen && !bypassBackoff) return drainInFlight;
    await drainInFlight;
  }
  drainInFlight = (async () => {
    const synced: OutboxSyncedPayload[] = [];
    const records = await readOutboxRecords();
    for (const initial of records) {
      await withUmidLock(initial.user_message_id, async () => {
        const record =
          (await readOutboxRecord(initial.user_message_id)) ?? initial;
        const payload = await processOneOutboxRecord(record, {
          salvageOpen,
          bypassBackoff,
          conversationIds,
          userMessageIds,
          salvageFinishReason,
          salvageErrorMessage,
        });
        if (payload) synced.push(payload);
      });
    }
    return { status: await statusSnapshot(), synced };
  })().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}

export async function statusSnapshot(): Promise<OutboxStatusSnapshot> {
  const records = await readOutboxRecords();
  const pending: OutboxPendingEntry[] = records
    .filter((r) => r.phase === PHASE_OPEN || r.phase === PHASE_READY)
    .map((r) => ({
      userMessageId: r.user_message_id,
      conversationId: r.conversation_id,
      phase: r.phase === PHASE_READY ? "ready" : "open",
      updatedAt: r.updated_at ?? 0,
    }));
  return { pending };
}

export async function flushTurn(
  userMessageId: string,
): Promise<OutboxFlushTurnResult> {
  // Poll briefly: sidecar may still be sealing finalize when renderer asks.
  const deadline = Date.now() + 15_000;
  let lastConversationId = "";
  while (Date.now() < deadline) {
    // Bypass backoff so an explicit user wait is not stuck behind next_attempt_at.
    const { synced } = await drainOutboxDetailed({ bypassBackoff: true });
    const hit = synced.find((s) => s.userMessageId === userMessageId);
    if (hit) return { ok: true, synced: hit };

    const records = await readOutboxRecords();
    const still = records.find((r) => r.user_message_id === userMessageId);
    if (!still) {
      // Moved to dead-letter (false ack / permanent 4xx) — not a successful sync.
      const dead = (await readDeadLetterRecords()).find(
        (r) => r.user_message_id === userMessageId,
      );
      if (dead) {
        return { ok: false, error: "writeback_dead" };
      }
      // Already drained by a concurrent poll — treat as success (idempotent).
      const conversationId =
        lastConversationId || recentSyncedConversation.get(userMessageId) || "";
      return {
        ok: true,
        synced: {
          conversationId,
          userMessageId,
          cloudUserMessageId: userMessageId,
          assistantMessageId: null,
          title: null,
        },
      };
    }
    lastConversationId = still.conversation_id || lastConversationId;
    if (still.phase === PHASE_OPEN) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    // Still ready after drain ⇒ auth / network failure — keep file for retry.
    return { ok: false, error: "writeback_pending" };
  }
  return { ok: false, error: "timeout" };
}

/**
 * Local-persistence recovery (as-built: 双模式工作区 §10.4): pause stale-claim
 * recovery is owned by the Python store on sidecar start; here we drain outbox,
 * salvage abandoned open rows with body/process, and discard begin-only empty shells.
 *
 * Unscoped (app start): skip conversations still writing.
 * ``conversationIds``: this dead sidecar only.
 * ``userMessageIds``: this failed occupy only — never a full sweep.
 */
export async function recoverLocalPersistence(
  opts?: RecoverLocalPersistenceOpts,
): Promise<void> {
  await drainOutboxDetailed({
    salvageOpen: true,
    conversationIds: opts?.conversationIds,
    userMessageIds: opts?.userMessageIds,
    salvageFinishReason: opts?.salvageFinishReason,
    salvageErrorMessage: opts?.salvageErrorMessage,
  });
}

/** After occupy succeeded: salvage or abort **this** OPEN file only. */
export async function handleOccupiedTurnSidecarFailure(args: {
  conversationId: string;
  userMessageId: string;
  messageId: string;
  /** Occupied RPC stop ownership; default is observed RPC error. */
  finishReason?: "cancelled" | "interrupted" | "error";
  errorMessage?: string;
}): Promise<void> {
  const userMessageId = args.userMessageId.trim();
  const record = await readOutboxRecord(userMessageId);
  if (shouldSalvageOpenRecord(record)) {
    await recoverLocalPersistence({
      userMessageIds: [userMessageId],
      salvageFinishReason: args.finishReason ?? "error",
      salvageErrorMessage: args.errorMessage,
    });
    return;
  }
  await abortLocalTurnPlaceholder(args);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startOutboxPolling(intervalMs = 2000): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void drainOutbox();
  }, intervalMs);
}

export function stopOutboxPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function registerOutboxIpc(): void {
  ipcMain.handle(OUTBOX_CHANNELS.flush, async () => drainOutbox());
  ipcMain.handle(
    OUTBOX_CHANNELS.flushTurn,
    async (_e, req: { userMessageId?: string }) => {
      const id = String(req?.userMessageId || "").trim();
      if (!id) return { ok: false, error: "missing_user_message_id" };
      return flushTurn(id);
    },
  );
  ipcMain.handle(OUTBOX_CHANNELS.status, async () => statusSnapshot());
  ipcMain.handle(OUTBOX_CHANNELS.authRefresh, async () => refreshAccessToken());
  ipcMain.handle(OUTBOX_CHANNELS.persistAuthCookies, async () =>
    persistAuthCookies(),
  );

  void recoverLocalPersistence();
  startOutboxPolling();
  startOutboxProjectionWatch();

  app.on("before-quit", () => {
    stopOutboxProjectionWatch();
    stopOutboxPolling();
    void drainOutbox();
  });
}
