/**
 * Bounded OS event-log summary (Host L1).
 *
 * Win: Get-WinEvent; Linux: journalctl; other OS: honest stub.
 * Hard caps on entry count + payload bytes; secret-shaped tokens redacted
 * (paths kept). Never a full-disk / arbitrary *\\logs dump.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostOpResult } from "@shared/host-contract";
import { runPowerShellEncoded } from "./powershell";
import { err, ok } from "./result";

const execFileAsync = promisify(execFile);

export const OS_LOG_MINUTES_DEFAULT = 60;
export const OS_LOG_MINUTES_MAX = 1440;
export const OS_LOG_ENTRIES_DEFAULT = 40;
export const OS_LOG_ENTRIES_MAX = 80;
export const OS_LOG_BYTES_DEFAULT = 24_000;
export const OS_LOG_BYTES_MAX = 48_000;

export type OsLogLevel = "error" | "warning" | "info" | "any";

export interface OsLogArgs {
  source?: string;
  level?: OsLogLevel;
  minutes?: number;
  max_entries?: number;
  max_bytes?: number;
}

export interface OsLogEntry {
  time: string;
  level: string;
  source: string;
  message: string;
}

const LEVELS: ReadonlySet<string> = new Set([
  "error",
  "warning",
  "info",
  "any",
]);

/** Secret-shaped redaction — keep paths; mask token/key/password forms. */
const SECRET_SHAPES: RegExp[] = [
  /(?<![A-Za-z0-9])(?:sk|tvly|gsk|xai)[-_][A-Za-z0-9._-]{8,}/gi,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9._-]{16,}/g,
  /(?<![A-Za-z0-9])gh[opsru]_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|authorization)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
];

export function redactOsLogText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_SHAPES) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function normalizeOsLogArgs(args: Record<string, unknown> | OsLogArgs): {
  source: string;
  level: OsLogLevel;
  minutes: number;
  maxEntries: number;
  maxBytes: number;
} {
  const source = String(args.source ?? "")
    .trim()
    .slice(0, 120);
  const rawLevel = String(args.level ?? "warning")
    .trim()
    .toLowerCase();
  const level = (LEVELS.has(rawLevel) ? rawLevel : "warning") as OsLogLevel;
  return {
    source,
    level,
    minutes: clampInt(
      args.minutes,
      OS_LOG_MINUTES_DEFAULT,
      1,
      OS_LOG_MINUTES_MAX,
    ),
    maxEntries: clampInt(
      args.max_entries,
      OS_LOG_ENTRIES_DEFAULT,
      1,
      OS_LOG_ENTRIES_MAX,
    ),
    maxBytes: clampInt(
      args.max_bytes,
      OS_LOG_BYTES_DEFAULT,
      1024,
      OS_LOG_BYTES_MAX,
    ),
  };
}

function truncateEntries(
  entries: OsLogEntry[],
  maxEntries: number,
  maxBytes: number,
): { entries: OsLogEntry[]; truncated: boolean } {
  const capped = entries.slice(0, maxEntries).map((e) => ({
    time: e.time,
    level: e.level,
    source: redactOsLogText(e.source).slice(0, 200),
    message: redactOsLogText(e.message).slice(0, 2000),
  }));
  let truncated = entries.length > maxEntries;
  const kept: OsLogEntry[] = [];
  let used = 2; // []
  for (const e of capped) {
    const piece = JSON.stringify(e).length + (kept.length ? 1 : 0);
    if (used + piece > maxBytes) {
      truncated = true;
      break;
    }
    kept.push(e);
    used += piece;
  }
  return { entries: kept, truncated };
}

function envelope(
  platform: string,
  opts: {
    source: string;
    level: OsLogLevel;
    minutes: number;
    maxEntries: number;
    maxBytes: number;
    entries: OsLogEntry[];
    backend: string;
    truncated?: boolean;
    note?: string;
    stub?: boolean;
  },
): HostOpResult {
  const { entries, truncated } = truncateEntries(
    opts.entries,
    opts.maxEntries,
    opts.maxBytes,
  );
  return ok({
    platform,
    source: opts.source || null,
    level: opts.level,
    minutes: opts.minutes,
    max_entries: opts.maxEntries,
    max_bytes: opts.maxBytes,
    count: entries.length,
    truncated: truncated || Boolean(opts.truncated),
    bounded: true,
    backend: opts.backend,
    entries,
    note: opts.note ?? "os_event_log_bounded_summary",
    ...(opts.stub ? { stub: true } : {}),
  });
}

async function hostOsLogWin(opts: {
  source: string;
  level: OsLogLevel;
  minutes: number;
  maxEntries: number;
  maxBytes: number;
}): Promise<HostOpResult> {
  // Pull a slightly larger raw cap then truncate by bytes in TS.
  const rawCap = Math.min(OS_LOG_ENTRIES_MAX, opts.maxEntries * 2);
  const levelFilter =
    opts.level === "error"
      ? "1,2"
      : opts.level === "warning"
        ? "1,2,3"
        : opts.level === "info"
          ? "1,2,3,4"
          : "";
  const levelAllowPs = levelFilter ? `@(${levelFilter})` : "@()";
  const sourceLit = opts.source.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$start = (Get-Date).AddMinutes(-${opts.minutes})
$rawCap = ${rawCap}
$levelAllow = ${levelAllowPs}
$sourceFilter = '${sourceLit}'
$logNames = @('Application','System')
$rows = New-Object System.Collections.Generic.List[object]
foreach ($log in $logNames) {
  try {
    $evts = Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $start } -MaxEvents $rawCap -ErrorAction SilentlyContinue
  } catch {
    continue
  }
  if (-not $evts) { continue }
  foreach ($e in $evts) {
    if ($levelAllow.Count -gt 0 -and $levelAllow -notcontains [int]$e.Level) { continue }
    $prov = [string]$e.ProviderName
    $msg = [string]$e.Message
    if ($sourceFilter) {
      $hay = ($prov + ' ' + $msg + ' ' + $log)
      if ($hay -notlike ('*' + $sourceFilter + '*')) { continue }
    }
    $levelName = switch ([int]$e.Level) {
      1 { 'Critical' }
      2 { 'Error' }
      3 { 'Warning' }
      4 { 'Information' }
      default { 'Other' }
    }
    $rows.Add([PSCustomObject]@{
      time = $e.TimeCreated.ToUniversalTime().ToString('o')
      level = $levelName
      source = $prov
      message = if ($msg.Length -gt 2000) { $msg.Substring(0, 2000) } else { $msg }
    })
    if ($rows.Count -ge $rawCap) { break }
  }
  if ($rows.Count -ge $rawCap) { break }
}
$sorted = $rows | Sort-Object time -Descending | Select-Object -First $rawCap
,@($sorted) | ConvertTo-Json -Compress -Depth 4
`.trim();
  try {
    const raw = await runPowerShellEncoded(ps, 25_000);
    let parsed: unknown = [];
    if (raw) {
      parsed = JSON.parse(raw) as unknown;
    }
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const entries: OsLogEntry[] = list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        time: String(x.time ?? ""),
        level: String(x.level ?? ""),
        source: String(x.source ?? ""),
        message: String(x.message ?? ""),
      }));
    return envelope("win32", {
      ...opts,
      entries,
      backend: "Get-WinEvent",
    });
  } catch (e) {
    return err(
      e instanceof Error ? e.message : String(e),
      "HostOsLogProbeError",
    );
  }
}

async function hostOsLogLinux(opts: {
  source: string;
  level: OsLogLevel;
  minutes: number;
  maxEntries: number;
  maxBytes: number;
}): Promise<HostOpResult> {
  const rawCap = Math.min(OS_LOG_ENTRIES_MAX, opts.maxEntries * 2);
  const priority =
    opts.level === "error"
      ? "0..3"
      : opts.level === "warning"
        ? "0..4"
        : opts.level === "info"
          ? "0..6"
          : "0..7";
  // Free-text source filter applied in JS (substring); do not pass exact journal matches.
  const args = [
    `--since=${opts.minutes} min ago`,
    "-n",
    String(rawCap),
    "-p",
    priority,
    "-o",
    "json",
    "--no-pager",
  ];
  try {
    const { stdout, stderr } = await execFileAsync("journalctl", args, {
      timeout: 20_000,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      windowsHide: true,
    });
    const lines = (stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const entries: OsLogEntry[] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const pri = Number(row.PRIORITY ?? 6);
        const levelName =
          pri <= 2
            ? "Critical"
            : pri === 3
              ? "Error"
              : pri === 4
                ? "Warning"
                : "Information";
        const ident = String(
          row.SYSLOG_IDENTIFIER ?? row._SYSTEMD_UNIT ?? row._COMM ?? "journal",
        );
        const msg = String(row.MESSAGE ?? "");
        if (
          opts.source &&
          !ident.toLowerCase().includes(opts.source.toLowerCase()) &&
          !msg.toLowerCase().includes(opts.source.toLowerCase())
        ) {
          continue;
        }
        const usec = String(row.__REALTIME_TIMESTAMP ?? "");
        let time = "";
        if (/^\d+$/.test(usec)) {
          time = new Date(Number(usec) / 1000).toISOString();
        }
        entries.push({
          time,
          level: levelName,
          source: ident,
          message: msg.slice(0, 2000),
        });
      } catch {
        // skip malformed journal line
      }
    }
    return envelope("linux", {
      ...opts,
      entries,
      backend: "journalctl",
      note: stderr?.trim()
        ? `os_event_log_bounded_summary; journalctl_stderr=${stderr.trim().slice(0, 200)}`
        : undefined,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Missing journalctl / permission → honest failure, not invented entries.
    return err(
      `journalctl unavailable or failed: ${detail}`,
      "HostOsLogProbeError",
    );
  }
}

export async function hostOsLogSummary(
  args: Record<string, unknown> = {},
): Promise<HostOpResult> {
  const opts = normalizeOsLogArgs(args);
  if (process.platform === "win32") {
    return hostOsLogWin(opts);
  }
  if (process.platform === "linux") {
    return hostOsLogLinux(opts);
  }
  return envelope(process.platform, {
    ...opts,
    entries: [],
    backend: "stub",
    stub: true,
    note:
      "os_event_log_bounded_summary_not_implemented_on_this_os; " +
      "Win=Get-WinEvent · Linux=journalctl; not a full host Event Log dump",
  });
}
