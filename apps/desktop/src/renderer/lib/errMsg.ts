import { ApiError } from "@/services/api";

/**
 * Prefer the backend's user-facing message (`{ error: { message } }`) over a
 * generic fallback, so a form / card echoes exactly why a request was rejected.
 *
 * The backend is the single source of the error contract and already ships a zh
 * sentence for most coded errors — anything that is not an {@link ApiError}
 * (transport failures, thrown strings, bugs) has no such message and falls back.
 *
 * Use this for the inline "this one action failed" copy next to a control. For a
 * full normalized view (remedy link, retriable, code) use `describeError` in
 * `lib/errors.ts` instead.
 */
export function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? (e.serverMessage ?? fallback) : fallback;
}
