// AgentCore error-code contract — the single shared directory of user-facing error
// codes for BOTH desktop and mobile. Mirrors the backend ErrorCode StrEnum in
// apps/server/agentcore/core/error_codes.py (hand-kept in sync — there is no codegen
// for this yet, so when the backend adds a code, add it here too). Every `error`
// SSE event and every REST `{ error: { code } }` body carries one of these.
//
// The policy sets below (key-config remedy / non-retriable) are data, so this module
// ships runtime values (not just types) — both clients import them and therefore phrase
// and act on a given code IDENTICALLY, instead of each hard-coding its own short list
// (the bug this replaces: the desktop只认 2 码).

/** The canonical code list — the runtime catalog `ErrorCode` is derived from, so the
 * union type and the value list can never drift apart. Grouped by origin. */
export const ERROR_CODES = [
  // generic / pipeline plumbing
  "INTERNAL_ERROR",
  "PIPELINE_ERROR",
  "STREAM_ERROR",
  "INVALID",
  // request validation / resource
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  // auth / quota / rate
  "AUTH_ERROR",
  "FORBIDDEN",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  // LLM provider (DeepSeek / BYOK)
  "LLM_ERROR",
  "LLM_RATE_LIMIT",
  "LLM_TIMEOUT",
  "LLM_INSUFFICIENT_BALANCE",
  "LLM_KEY_INVALID",
  "LLM_KEY_REQUIRED",
  "KEY_STORAGE_UNAVAILABLE",
  // tools / sandbox
  "TOOL_ERROR",
  "TOOL_NOT_FOUND",
  "SANDBOX_ERROR",
  "SANDBOX_TIMEOUT",
  // handoff (跨端接力)
  "HANDOFF_DISPATCH_FAILED",
  "HANDOFF_FAILED",
  "HANDOFF_SNAPSHOT_NOT_FOUND",
  "HANDOFF_APPLY_FAILED",
] as const;

/** A backend error code: the `code` on an SSE `error` event or a REST `{error:{code}}`. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes whose remedy is to (re)configure the BYOK key in 设置·模型配置 — the client
 * offers a one-click "去配置" route instead of a retry. `LLM_INSUFFICIENT_BALANCE` is
 * deliberately NOT here: its fix is DeepSeek's billing page (surfaced via the backend's
 * own message), not AgentCore's key settings. */
export const KEY_CONFIG_ERROR_CODES: readonly ErrorCode[] = [
  "LLM_KEY_REQUIRED",
  "LLM_KEY_INVALID",
];

/** Codes where an immediate retry is pointless until the user acts — top up the wallet,
 * fix/add the key, wait for quota, or fix server config. The client suppresses the
 * retry affordance for these (rate limits stay retriable: they clear on their own). */
export const NON_RETRIABLE_ERROR_CODES: readonly ErrorCode[] = [
  "QUOTA_EXCEEDED",
  "LLM_KEY_REQUIRED",
  "LLM_KEY_INVALID",
  "LLM_INSUFFICIENT_BALANCE",
  "KEY_STORAGE_UNAVAILABLE",
];

/** Type guard: whether `code` is a code the clients recognize (typed against the
 * shared catalog), letting call sites narrow an opaque wire string to `ErrorCode`. */
export function isKnownErrorCode(code: string | undefined): code is ErrorCode {
  return (
    code !== undefined && (ERROR_CODES as readonly string[]).includes(code)
  );
}
