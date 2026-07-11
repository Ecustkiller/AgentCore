/**
 * Main-process outbox writebacker (as-built: 双模式工作区 §10.3 / §10.4; 前端技术 §7.2).
 *
 * Reads sidecar outbox JSON under `<userData>/sidecar/outbox/`, POSTs ready
 * records to `/v1/conversations/{id}/local-turns` via pure Bearer, deletes on
 * cloud ack, and pushes reconcile payloads to the renderer.
 *
 * Pause/outbox split (as-built: 双模式工作区 §10.4): pause frames live under
 * `…/paused/` and are handled by SidecarManager — this module only processes
 * outbox. Shared scan entry: {@link recoverLocalPersistence}.
 */
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  OUTBOX_CHANNELS,
  type OutboxFlushTurnResult,
  type OutboxPendingEntry,
  type OutboxStatusSnapshot,
  type OutboxSyncedPayload,
} from "@shared/outbox-contract";
import { BrowserWindow, app, ipcMain } from "electron";
import { bearerPostJson, refreshAccessToken } from "./auth-client";

const PHASE_READY = "ready";
const PHASE_OPEN = "open";

export function sidecarDataDir(): string {
  return join(app.getPath("userData"), "sidecar");
}

export function outboxDir(): string {
  return join(sidecarDataDir(), "outbox");
}

export function pausedDir(): string {
  return join(sidecarDataDir(), "paused");
}

interface OutboxRecord {
  schema_version?: number;
  user_message_id: string;
  conversation_id: string;
  message_id?: string | null;
  trace_id?: string;
  user_message?: string;
  content?: string;
  reasoning_content?: string | null;
  citations?: unknown[];
  runs?: unknown;
  /** seq(str) → {kind,payload,ts} — progressive journal; crash salvage has no runs. */
  journal?: Record<string, unknown>;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  rounds?: number;
  finish_reason?: string | null;
  phase?: string;
  updated_at?: number;
}

function journalEntriesFromMap(
  journal: Record<string, unknown> | undefined,
): unknown[] | undefined {
  if (!journal || typeof journal !== "object") return undefined;
  const keys = Object.keys(journal).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  if (keys.length === 0) return undefined;
  return keys.map((k) => journal[k]);
}

function toRecordTurnBody(record: OutboxRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    user_message: record.user_message || "",
    user_message_id: record.user_message_id,
    content: record.content || "",
    reasoning_content: record.reasoning_content ?? null,
    citations: record.citations || [],
    runs: record.runs ?? null,
    message_id: record.message_id ?? null,
    input_tokens: record.input_tokens ?? 0,
    output_tokens: record.output_tokens ?? 0,
    reasoning_tokens: record.reasoning_tokens ?? 0,
    cache_hit_tokens: record.cache_hit_tokens ?? 0,
    cache_miss_tokens: record.cache_miss_tokens ?? 0,
    rounds: record.rounds ?? 0,
    trace_id: record.trace_id || "",
    finish_reason: record.finish_reason ?? null,
  };
  const journal = journalEntriesFromMap(record.journal);
  if (journal) body.journal = journal;
  return body;
}

async function readOutboxRecords(): Promise<OutboxRecord[]> {
  const dir = outboxDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: OutboxRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf-8");
      const data = JSON.parse(raw) as OutboxRecord;
      if (data?.user_message_id && data.conversation_id) records.push(data);
    } catch {
      // torn / unreadable — skip
    }
  }
  return records;
}

function pushSynced(payload: OutboxSyncedPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(OUTBOX_CHANNELS.synced, payload);
    }
  }
}

async function writeRecord(record: OutboxRecord): Promise<void> {
  const dir = outboxDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${record.user_message_id}.json`);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(record), "utf-8");
  await rename(tmp, target);
}

async function deleteRecord(userMessageId: string): Promise<void> {
  try {
    await unlink(join(outboxDir(), `${userMessageId}.json`));
  } catch {
    /* already gone */
  }
}

/** Recent successful writebacks — fills synthetic flushTurn ack when the file is already gone. */
const recentSyncedConversation = new Map<string, string>();

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
  /** Promote abandoned open records (app-restart salvage). Never use while turns may still run. */
  salvageOpen?: boolean;
}): Promise<{
  status: OutboxStatusSnapshot;
  synced: OutboxSyncedPayload[];
}> {
  if (drainInFlight) return drainInFlight;
  const salvageOpen = opts?.salvageOpen === true;
  drainInFlight = (async () => {
    const synced: OutboxSyncedPayload[] = [];
    const records = await readOutboxRecords();
    for (const record of records) {
      // App-restart salvage only: open + has content → treat as ready incomplete.
      // Regular polling must NOT promote open rows — the sidecar may still be writing.
      if (
        salvageOpen &&
        record.phase === PHASE_OPEN &&
        (record.content || "").trim()
      ) {
        record.phase = PHASE_READY;
        // Align with CloudStore.salvage / OutboxStore.salvage: cancelled + incomplete.
        record.finish_reason = record.finish_reason || "cancelled";
        try {
          await writeRecord(record);
        } catch (err) {
          console.error("[outbox] salvage promote failed", err);
          continue;
        }
      }
      if (record.phase !== PHASE_READY) continue;
      if (!(record.user_message || "").trim()) continue;
      if (
        !(record.trace_id || "").trim() ||
        (record.trace_id || "").length !== 32
      ) {
        continue;
      }

      const path = `/v1/conversations/${record.conversation_id}/local-turns`;
      const result = await bearerPostJson(path, toRecordTurnBody(record));
      if (!result.ok) {
        console.error(
          "[outbox] writeback failed",
          record.user_message_id,
          result.status,
          result.body,
        );
        continue;
      }
      const body = result.body as {
        user_message_id?: string;
        assistant_message_id?: string | null;
        title?: string | null;
      };
      const payload: OutboxSyncedPayload = {
        conversationId: record.conversation_id,
        userMessageId: record.user_message_id,
        cloudUserMessageId: body.user_message_id || record.user_message_id,
        assistantMessageId: body.assistant_message_id ?? null,
        title: body.title ?? null,
      };
      await deleteRecord(record.user_message_id);
      recentSyncedConversation.set(
        record.user_message_id,
        record.conversation_id,
      );
      pushSynced(payload);
      synced.push(payload);
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
    const { synced } = await drainOutboxDetailed();
    const hit = synced.find((s) => s.userMessageId === userMessageId);
    if (hit) return { ok: true, synced: hit };

    const records = await readOutboxRecords();
    const still = records.find((r) => r.user_message_id === userMessageId);
    if (!still) {
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
 * recovery is owned by the Python store on sidecar start; here we drain outbox
 * and salvage abandoned open rows.
 */
export async function recoverLocalPersistence(): Promise<void> {
  await drainOutboxDetailed({ salvageOpen: true });
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

  void recoverLocalPersistence();
  startOutboxPolling();

  app.on("before-quit", () => {
    stopOutboxPolling();
    void drainOutbox();
  });
}
