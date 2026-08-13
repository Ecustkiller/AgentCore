import { productCopyOverride } from "@/lib/errors";
import { ApiError } from "@/services/api";

/**
 * Prefer the backend's user-facing message (`{ error: { message } }`) over a
 * generic fallback, so a form / card echoes exactly why a request was rejected.
 *
 * The backend is the single source of the error contract and already ships a zh
 * sentence for most coded errors — anything that is not an {@link ApiError}
 * (transport failures, thrown strings, bugs) has no such message and falls back.
 * The few codes whose server message is developer-facing English are overridden
 * by the shared copy map, so an inline form message and a toast for the same
 * failure read identically.
 *
 * Use this for the inline "this one action failed" copy next to a control. For a
 * full normalized view (remedy link, retriable, code) use `describeError` in
 * `lib/errors.ts` instead.
 */
export function errMsg(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  return productCopyOverride(e.code) ?? e.serverMessage ?? fallback;
}
