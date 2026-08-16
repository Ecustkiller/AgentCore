/**
 * Strip desktop.jsonl down to connectivity / recovery diagnostics.
 *
 * The write path already forbids tokens / passwords / message bodies in
 * ``fields``, but a support pack leaves the user's machine — allowlist events
 * and primitive fields so a leaked content/token key cannot ride along.
 */

/** Events that explain disconnect / rejoin. Everything else is dropped. */
const EVENT_ALLOW_PREFIXES = [
  "server_health.",
  "sse.",
  "conversation.follow_",
  "conversation.rejoin_",
] as const;

const EVENT_ALLOW_EXACT = new Set(["sidecar.turn_already_running"]);

const FIELD_ALLOW = new Set([
  "timestamp",
  "level",
  "event",
  "build",
  "version",
  "conversation_id",
  "source",
  "reason",
  "last_ok_at",
  "from",
  "consecutive_failures",
  "since_offline_ms",
  "status",
  "failure_threshold",
  "saw_any_event",
  "op",
  "turn_id",
  "request_id",
  "attempts",
  "attempt",
  "outcome",
  "delay_ms",
  "duration_ms",
]);

const SECRET_KEY =
  /token|password|secret|authorization|cookie|content|body|text|path|filename|message/i;

const JWT_LIKE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Soft cap after the 64KB file tail. 80 was too tight: a reconnect storm
 * plus follow/sse noise could push ``server_health.*`` (no conversation_id)
 * out of the pack. Ambient events are never dropped to make room for scoped
 * ones (see {@link trimDesktopLogExcerpt}).
 */
export const DESKTOP_LOG_EXCERPT_MAX_EVENTS = 400;

export function isAllowedDesktopLogEvent(event: string): boolean {
  if (EVENT_ALLOW_EXACT.has(event)) return true;
  return EVENT_ALLOW_PREFIXES.some((prefix) => event.startsWith(prefix));
}

/** App-wide connectivity — ``server_health.*`` never carries conversation_id. */
export function isAmbientDesktopLogEvent(event: string): boolean {
  return event.startsWith("server_health.");
}

/**
 * Keep a sanitized record in a conversation's 排查包?
 *
 * ``server_health.*`` and any allowlisted line with no ``conversation_id``
 * are session-unrelated diagnostics (offline banner / event-loop / network)
 * and must stay. Only drop lines that name a *different* conversation.
 */
export function isRelevantDesktopLogRecord(
  record: {
    event?: unknown;
    conversation_id?: unknown;
    [key: string]: unknown;
  },
  conversationId?: string | null,
): boolean {
  const event = typeof record.event === "string" ? record.event : "";
  if (event && isAmbientDesktopLogEvent(event)) return true;
  const cid = record.conversation_id;
  if (typeof cid !== "string" || !cid) return true;
  const want = conversationId?.trim() || "";
  return !want || cid === want;
}

function trimDesktopLogExcerpt(
  rows: Array<{ line: string; ambient: boolean }>,
  maxEvents: number,
): string[] {
  if (rows.length <= maxEvents) return rows.map((r) => r.line);
  const ambientCount = rows.reduce((n, r) => n + (r.ambient ? 1 : 0), 0);
  const scopedBudget = Math.max(
    0,
    maxEvents - Math.min(ambientCount, maxEvents),
  );
  const picked: Array<{ line: string; ambient: boolean }> = [];
  let scopedKept = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.ambient) {
      picked.push(row);
    } else if (scopedKept < scopedBudget) {
      picked.push(row);
      scopedKept += 1;
    }
  }
  picked.reverse();
  return picked.length > maxEvents
    ? picked.slice(-maxEvents).map((r) => r.line)
    : picked.map((r) => r.line);
}

function looksSecret(value: string): boolean {
  if (value.startsWith("sk-") || /^Bearer\s+/i.test(value)) return true;
  if (value.length > 20 && JWT_LIKE.test(value)) return true;
  return false;
}

function isAllowedPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  if (value === null) return true;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  return !looksSecret(value);
}

function pickAllowedFields(
  record: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!FIELD_ALLOW.has(key)) continue;
    if (SECRET_KEY.test(key) && key !== "reason") continue;
    if (!isAllowedPrimitive(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * One JSONL line → allowlisted record, or ``null`` if it is not diagnostic.
 */
export function sanitizeDesktopLogRecord(
  raw: unknown,
): Record<string, string | number | boolean | null> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const event = typeof rec.event === "string" ? rec.event : "";
  if (!event || !isAllowedDesktopLogEvent(event)) return null;

  const fields =
    rec.fields && typeof rec.fields === "object" && !Array.isArray(rec.fields)
      ? (rec.fields as Record<string, unknown>)
      : {};

  const picked = pickAllowedFields({ ...fields, ...rec, event });
  if (typeof picked.event !== "string") return null;
  return picked;
}

/** Drop a leading partial line when the tail started mid-record. */
export function dropPartialJsonlPrefix(text: string): string {
  if (!text) return "";
  if (text.startsWith("{")) return text;
  const nl = text.indexOf("\n");
  return nl < 0 ? "" : text.slice(nl + 1);
}

export function sanitizeDesktopLogLines(
  text: string,
  opts?: { conversationId?: string | null; maxEvents?: number },
): string[] {
  const conversationId = opts?.conversationId?.trim() || "";
  const maxEvents = opts?.maxEvents ?? DESKTOP_LOG_EXCERPT_MAX_EVENTS;
  const lines = dropPartialJsonlPrefix(text).split("\n");
  const kept: Array<{ line: string; ambient: boolean }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const sanitized = sanitizeDesktopLogRecord(parsed);
    if (!sanitized) continue;
    if (!isRelevantDesktopLogRecord(sanitized, conversationId)) continue;
    const event = sanitized.event;
    kept.push({
      line: JSON.stringify(sanitized),
      ambient:
        typeof event === "string" &&
        (isAmbientDesktopLogEvent(event) ||
          typeof sanitized.conversation_id !== "string" ||
          !sanitized.conversation_id),
    });
  }
  return trimDesktopLogExcerpt(kept, maxEvents);
}
