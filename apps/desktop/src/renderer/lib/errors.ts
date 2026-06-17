import { ApiError, NetworkError } from "@/services/api";

/**
 * One place that turns any backend / transport error into the three things the
 * UI needs: a zh message, an optional one-click remedy, and whether an immediate
 * retry is worth offering. Both the REST client ({@link ApiError}) and the SSE
 * turn ({@link StreamError}) feed through here, so a given error `code` is phrased
 * and actioned identically wherever it surfaces — the turn banner, the inline
 * mid-stream card, and the REST toast.
 *
 * The backend is the single source of the error contract: every failure is
 * `{ error: { code, message } }` plus an HTTP status (and `Retry-After` on
 * cool-downs), produced by the global handler in `apps/server` over the
 * `AgentCoreError` hierarchy (`core/errors.py`). That `message` is already a
 * user-facing zh string for most coded errors, so we prefer it verbatim and only
 * fall back to generic phrasing when it is absent.
 */

// "sidecar" = a local-engine turn failure (spawn/init/engine/exit) whose precise
// reason rides on `serverMessage` — it is neither a real network outage nor an
// auth issue, so it falls through to the serverMessage branch in resolveMessage
// (a generic "network" banner would mask why the local engine couldn't run).
export type StreamErrorKind = "network" | "http" | "auth" | "sidecar";

/**
 * A transport-level failure of an SSE turn (distinct from a backend `error`
 * event, which is delivered inline). Carries a kind so the UI can phrase it, plus
 * the backend's `code` / `message` / `Retry-After` when the turn was refused with
 * a plain JSON 4xx (quota / rate limit / missing key) rather than an event stream.
 */
export class StreamError extends Error {
  code?: string;
  serverMessage?: string;
  retryAfter?: number;

  constructor(
    public kind: StreamErrorKind,
    public status?: number,
    extra?: { code?: string; serverMessage?: string; retryAfter?: number },
  ) {
    super(`stream ${kind}${status ? ` ${status}` : ""}`);
    this.name = "StreamError";
    this.code = extra?.code;
    this.serverMessage = extra?.serverMessage;
    this.retryAfter = extra?.retryAfter;
  }
}

/**
 * A one-click remedy that fixes the *cause* of an error by routing the user
 * somewhere (e.g. the model-config page to add a BYOK key), rather than retrying
 * the same operation. `href` is a hash-router path.
 */
export interface ErrorAction {
  label: string;
  href: string;
}

/**
 * Normalized, user-facing view of an error. A `null` return from
 * {@link describeError} means the UI should stay silent — auth failures already
 * redirect to the login screen, so a banner/toast on top would be noise.
 */
export interface DescribedError {
  /** zh message safe to show the user. */
  message: string;
  /** Optional remedy that fixes the cause by navigation, not by retry. */
  action: ErrorAction | null;
  /** Whether offering an immediate retry makes sense (false for refusals that
   * need a user action or a schedule, e.g. quota exhausted / missing key). */
  retriable: boolean;
  /** Backend error code, when known. */
  code?: string;
}

/**
 * Map a backend error `code` to a config remedy. Single source shared by the
 * transport-error banner, the inline mid-stream error card, and REST toasts, so
 * every surface phrases the same codes identically.
 */
export function errorActionForCode(
  code: string | undefined,
): ErrorAction | null {
  switch (code) {
    // No key configured (preflight 402) / a configured key rejected mid-stream
    // (401/403): both are fixed in 设置·模型配置.
    case "LLM_KEY_REQUIRED":
    case "LLM_KEY_INVALID":
      return { label: "去配置", href: "/more/model" };
    default:
      return null;
  }
}

/** The facts the message/action/retry rules read, extracted once from any error
 * shape so the rules below never branch on the concrete class. */
interface ErrorFacts {
  status?: number;
  code?: string;
  serverMessage?: string;
  retryAfter?: number;
  /** Transport failure: the server never answered (offline / DNS / reset). */
  transport: boolean;
  /** Auth failure: the UI stays silent because a redirect handles it. */
  auth: boolean;
}

function factsOf(err: unknown): ErrorFacts {
  if (err instanceof StreamError) {
    return {
      status: err.status,
      code: err.code,
      serverMessage: err.serverMessage,
      retryAfter: err.retryAfter,
      transport: err.kind === "network",
      auth: err.kind === "auth",
    };
  }
  if (err instanceof ApiError) {
    return {
      status: err.status,
      code: err.code,
      serverMessage: err.serverMessage,
      retryAfter: err.retryAfter,
      transport: false,
      auth: err.status === 401,
    };
  }
  if (err instanceof NetworkError) {
    return { transport: true, auth: false };
  }
  return { transport: false, auth: false };
}

function resolveMessage(f: ErrorFacts): string {
  if (f.transport) return "网络连接中断，请检查网络后重试";
  // A 429 is a deliberate refusal (quota used up, or sending too fast), not an
  // outage. The backend ships a precise zh message (quota reset time, or a
  // cool-down), so prefer it; otherwise phrase the wait from Retry-After.
  if (f.status === 429) {
    if (f.serverMessage) return f.serverMessage;
    if (f.retryAfter) return `操作过于频繁，请约 ${f.retryAfter} 秒后再试`;
    return "操作过于频繁或额度已用尽，请稍后再试";
  }
  // A 402 LLM_KEY_REQUIRED is a deliberate BYOK refusal (no DeepSeek key yet);
  // surface the backend's actionable message (or a config hint), never a
  // misleading "service unavailable".
  if (f.code === "LLM_KEY_REQUIRED") {
    return (
      f.serverMessage ??
      "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。"
    );
  }
  // Most coded errors carry a user-facing zh message (validation / conflict /
  // invalid key / insufficient balance …) — prefer it verbatim (single-sourced).
  if (f.serverMessage) return f.serverMessage;
  if (f.status && f.status >= 500)
    return `服务暂时不可用（${f.status}），请重试`;
  if (f.status) return `操作失败（${f.status}），请重试`;
  return "操作失败，请重试";
}

/**
 * Normalize any error into the {@link DescribedError} the UI shows, or `null`
 * when the UI should stay silent (auth → the login redirect handles it).
 */
export function describeError(err: unknown): DescribedError | null {
  const f = factsOf(err);
  if (f.auth) return null;
  return {
    message: resolveMessage(f),
    action: errorActionForCode(f.code),
    retriable: !(f.code === "QUOTA_EXCEEDED" || f.code === "LLM_KEY_REQUIRED"),
    code: f.code,
  };
}

// ---- Streaming-turn helpers (thin wrappers over describeError) --------------
// Named for the SSE turn flow (banner + retry) and consumed by the turn resolver
// in services/turns.ts. They share describeError's code map so a turn banner and
// a REST toast phrase the same backend code identically.

/** zh message for a failed turn, or null when no banner should show. */
export function describeStreamError(err: unknown): string | null {
  return describeError(err)?.message ?? null;
}

/** Whether a failed turn should offer a retry. */
export function isRetriableStreamError(err: unknown): boolean {
  return describeError(err)?.retriable ?? true;
}

/** The config remedy for a failed turn, if any. */
export function streamErrorAction(err: unknown): ErrorAction | null {
  return describeError(err)?.action ?? null;
}
