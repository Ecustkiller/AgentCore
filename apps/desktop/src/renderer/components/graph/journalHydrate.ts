import { type Message, assistantProjectionId } from "@/stores/conversation";
import type { ExecutionJournal } from "@/stores/execution";

/** Message fields the canvas / detail hydrate trigger reads. */
export type JournalHostMessage = Pick<
  Message,
  "id" | "role" | "executionId" | "serverMessageId" | "runs"
>;

export type TeamJournalSlot = {
  key: string;
  journal: ExecutionJournal;
  /** Snapshotted at collect time so in-place `events.push` still looks newer. */
  events: number;
};

/**
 * Journal identity for hydrate triggers: projection key + `events.length`.
 * Object-identity of `m.runs` is compared separately by the caller (`===`).
 * Streaming content ticks that keep the same `runs` / length must not re-fold.
 */
export function teamJournalHydrateKey(
  messages: readonly JournalHostMessage[],
): string {
  let key = "";
  for (const m of messages) {
    if (m.role !== "assistant" || !m.executionId || !m.runs) continue;
    key += `${assistantProjectionId(m as Message)}:${m.runs.events.length};`;
  }
  return key;
}

export function collectTeamJournalSlots(
  messages: readonly JournalHostMessage[],
): TeamJournalSlot[] {
  const slots: TeamJournalSlot[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.executionId || !m.runs) continue;
    slots.push({
      key: assistantProjectionId(m as Message),
      journal: m.runs,
      events: m.runs.events.length,
    });
  }
  return slots;
}

export function teamJournalSlotsIdentityEqual(
  a: readonly TeamJournalSlot[],
  b: readonly TeamJournalSlot[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
    if (a[i].journal !== b[i].journal) return false;
    if (a[i].events !== b[i].events) return false;
  }
  return true;
}

/**
 * Next team journals to hydrate, or `null` when identity is unchanged.
 * Callers always hydrate returned slots (no `!plan` gate); the store applies
 * journalIsNewerThan inside hydrateFromJournal.
 */
export function teamJournalsIfIdentityChanged(
  prevSlots: readonly TeamJournalSlot[],
  messages: readonly JournalHostMessage[],
): TeamJournalSlot[] | null {
  const slots = collectTeamJournalSlots(messages);
  if (teamJournalSlotsIdentityEqual(prevSlots, slots)) return null;
  return slots;
}

/** Single-turn identity (TurnDetailPage / InlineTeamGraph). */
export function journalHydrateIdentity(
  journal: ExecutionJournal | undefined | null,
): { journal: ExecutionJournal; events: number } | null {
  if (!journal) return null;
  return { journal, events: journal.events.length };
}

export function journalHydrateIdentityEqual(
  a: { journal: ExecutionJournal; events: number } | null,
  b: { journal: ExecutionJournal; events: number } | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.journal === b.journal && a.events === b.events;
}
