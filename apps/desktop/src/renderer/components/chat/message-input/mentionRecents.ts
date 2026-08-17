import type { IndexedEntry } from "@/lib/fileIndex";
import { uiGet, uiSet } from "@/lib/uiStorage";

const STORAGE_KEY = "mention.recents";
const MAX_RECENTS = 80;

export function mentionRecentKey(
  entry: Pick<IndexedEntry, "kind" | "sourceId" | "relPath">,
): string {
  return `${entry.kind}:${entry.sourceId}:${entry.relPath}`;
}

function readRecords(): Array<{ key: string; at: number }> {
  const parsed = uiGet<unknown>(STORAGE_KEY);
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ key: string; at: number }> = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    if (typeof o.key === "string" && typeof o.at === "number") {
      out.push({ key: o.key, at: o.at });
    }
  }
  return out;
}

export function readMentionRecents(): Map<string, number> {
  return new Map(readRecords().map((r) => [r.key, r.at]));
}

export function recordMentionRecent(
  entry: Pick<IndexedEntry, "kind" | "sourceId" | "relPath">,
  at = Date.now(),
): void {
  const key = mentionRecentKey(entry);
  const next = readRecords().filter((r) => r.key !== key);
  next.unshift({ key, at });
  uiSet(STORAGE_KEY, next.slice(0, MAX_RECENTS));
}

export function stampMentionRecents(entries: IndexedEntry[]): IndexedEntry[] {
  const recents = readMentionRecents();
  if (recents.size === 0) return entries;
  return entries.map((e) => {
    const at = recents.get(mentionRecentKey(e));
    return at == null ? e : { ...e, lastUsedAt: at };
  });
}
