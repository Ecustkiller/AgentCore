import {
  type SupportDiagnosticIds,
  formatSupportDiagnosticText,
} from "@agentcore/protocol-fold-kit";
import {
  type SanitizedDesktopLogRecord,
  compactDesktopLogRecordsForPack,
  foldDesktopLogRecords,
  formatDesktopLogExcerptHeader,
  formatDesktopLogRoutineLine,
  hoistDesktopLogEnvelope,
  isRelevantDesktopLogRecord,
} from "@shared/desktop-log-sanitize";

export {
  formatSupportDiagnosticText,
  supportDiagnosticExtrasFromError,
  type SupportDiagnosticIds,
} from "@agentcore/protocol-fold-kit";

/** Preceding user bubble id for an assistant message (regenerate / 排查包). */
export function precedingUserMessageId(
  messages: ReadonlyArray<{ id: string; role: string }>,
  assistantMessageId: string,
): string | null {
  const idx = messages.findIndex((m) => m.id === assistantMessageId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return null;
}

const DESKTOP_LOG_SECTION = "--- desktop.jsonl ---";

function parseSanitizedDesktopLogLines(
  lines: readonly string[],
): SanitizedDesktopLogRecord[] {
  const records: SanitizedDesktopLogRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as SanitizedDesktopLogRecord);
      }
    } catch {}
  }
  return records;
}

/**
 * Append a sanitized ``desktop.jsonl`` excerpt so connectivity events can leave
 * the user's machine with the 排查包. Missing preload / empty tail → base pack.
 *
 * Duplicate events fold first; envelope fields hoist to the section head.
 * Routine open/hydrate/follow info then collapses to one ``routine:`` census
 * line so Cursor sees the window story without a JSON wall.
 */
export function appendSanitizedDesktopLogExcerpt(
  pack: string,
  lines: readonly string[],
): string {
  if (!pack || lines.length === 0) return pack;
  const records = parseSanitizedDesktopLogLines(lines);
  if (records.length === 0) return pack;
  const folded = foldDesktopLogRecords(records).filter(
    (record) => record.level !== "debug",
  );
  if (folded.length === 0) return pack;
  const { header, records: body } = hoistDesktopLogEnvelope(folded);
  const { routine, records: kept } = compactDesktopLogRecordsForPack(body);
  const headerLines = formatDesktopLogExcerptHeader(header);
  const routineLine = formatDesktopLogRoutineLine(routine);
  if (headerLines.length === 0 && !routineLine && kept.length === 0) {
    return pack;
  }
  const jsonl = kept.map((record) => JSON.stringify(record));
  return [
    pack,
    "",
    DESKTOP_LOG_SECTION,
    ...headerLines,
    ...(routineLine ? [routineLine] : []),
    ...jsonl,
  ].join("\n");
}

/**
 * Paste-ready 排查包 including a sanitized desktop.jsonl tail when the
 * main-process log API is available. IDs-only if the tail is empty or unreadable.
 */
export async function buildSupportDiagnosticPack(
  ids: SupportDiagnosticIds,
): Promise<string> {
  const base = formatSupportDiagnosticText(ids);
  if (!base) return "";
  try {
    const api = typeof window !== "undefined" ? window.logApi : undefined;
    const lines = api?.readTail ? await api.readTail(ids.conversationId) : [];
    if (lines.length === 0) return base;
    const conversationId = ids.conversationId?.trim() || "";
    const filtered = lines.filter((line) => {
      try {
        return isRelevantDesktopLogRecord(
          JSON.parse(line) as { event?: unknown; conversation_id?: unknown },
          conversationId,
        );
      } catch {
        return false;
      }
    });
    return appendSanitizedDesktopLogExcerpt(base, filtered);
  } catch {
    return base;
  }
}
