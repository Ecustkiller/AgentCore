/**
 * Outbox writeback — dead-letter IO + unsynced recovery summaries (D3/D5).
 */
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  SidecarCitation,
  SidecarRunsPayload,
  SidecarUnsyncedTurnSummary,
} from "@shared/sidecar-contract";
import {
  type OutboxRecord,
  PHASE_OPEN,
  PHASE_READY,
  deadLetterDir,
  fillFromCaptainStreamSegments,
  isSafeOutboxId,
  outboxDir,
  readOutboxRecords,
} from "./strategy";

/** Move outbox record to dead-letter/ (keep body for forensics; stop polling). */
export async function moveToDeadLetter(
  record: OutboxRecord,
  status: number,
): Promise<void> {
  console.error(
    "[outbox] permanent failure → dead-letter",
    record.user_message_id,
    status,
  );
  if (!isSafeOutboxId(record.user_message_id)) return;
  const destDir = deadLetterDir();
  await mkdir(destDir, { recursive: true });
  const src = join(outboxDir(), `${record.user_message_id}.json`);
  const dest = join(destDir, `${record.user_message_id}.json`);
  try {
    await rename(src, dest);
  } catch (err) {
    console.error(
      "[outbox] dead-letter move failed",
      record.user_message_id,
      err,
    );
  }
}

export async function readDeadLetterRecords(): Promise<OutboxRecord[]> {
  const dir = deadLetterDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: OutboxRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf-8");
      const data = JSON.parse(raw) as OutboxRecord;
      if (
        data?.user_message_id &&
        data.conversation_id &&
        isSafeOutboxId(data.user_message_id) &&
        isSafeOutboxId(data.conversation_id)
      ) {
        records.push(data);
      }
    } catch {
      // torn / unreadable — skip
    }
  }
  return records;
}

function toUnsyncedSummary(
  record: OutboxRecord,
  phase: SidecarUnsyncedTurnSummary["phase"],
): SidecarUnsyncedTurnSummary {
  const view: OutboxRecord = {
    ...record,
    stream_segments: record.stream_segments,
  };
  fillFromCaptainStreamSegments(view);
  return {
    user_message_id: view.user_message_id,
    user_message: view.user_message || "",
    message_id: view.message_id ?? null,
    trace_id: view.trace_id || "",
    phase,
    updated_at: view.updated_at ?? 0,
    content: view.content || "",
    reasoning_content: view.reasoning_content ?? null,
    citations: (view.citations as SidecarCitation[]) || [],
    runs: (view.runs as SidecarRunsPayload) ?? null,
    finish_reason: view.finish_reason ?? null,
    input_tokens: view.input_tokens ?? 0,
    output_tokens: view.output_tokens ?? 0,
    reasoning_tokens: view.reasoning_tokens ?? 0,
    cache_hit_tokens: view.cache_hit_tokens ?? 0,
    cache_miss_tokens: view.cache_miss_tokens ?? 0,
  };
}

/**
 * Project outbox records for a conversation into recovery summaries (D3/D5).
 *
 * Fills empty open-phase bodies from captain stream_segments. Does **not**
 * promote open→ready (that stays in startup salvage). Caller filters out the
 * live turn's open row when attaching.
 */
export async function listUnsyncedSummaries(
  conversationId: string,
): Promise<SidecarUnsyncedTurnSummary[]> {
  const records = await readOutboxRecords();
  const out: SidecarUnsyncedTurnSummary[] = [];
  for (const record of records) {
    if (record.conversation_id !== conversationId) continue;
    if (record.phase !== PHASE_OPEN && record.phase !== PHASE_READY) continue;
    // Mutate a shallow copy so we don't rewrite the on-disk open record here.
    out.push(
      toUnsyncedSummary(
        record,
        record.phase === PHASE_READY ? "ready" : "open",
      ),
    );
  }
  // Permanent writeback failures stay recoverable on the unsynced surface.
  for (const record of await readDeadLetterRecords()) {
    if (record.conversation_id !== conversationId) continue;
    out.push(toUnsyncedSummary(record, "dead"));
  }
  out.sort((a, b) => a.updated_at - b.updated_at);
  return out;
}
