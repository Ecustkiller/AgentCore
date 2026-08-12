import { logEvent } from "@/lib/log";
import {
  cancelClientToolByRequestId,
  dispatchClientToolRequired,
  isClientToolRequiredType,
} from "@/services/clientToolFrames";
import { type FulfillFrame, onFulfillFrame } from "@/services/fulfillStream";
import type { InteractionSettleOrigin } from "@/services/interaction";

/**
 * Fulfill channel → CLIENT_TOOL perform/settle bridge (D2).
 *
 * Both engines deliver through their own fulfill hub — never the conversation
 * display stream:
 * - cloud → `GET /v1/fulfill` SSE ({@link onFulfillFrame}), settles over HTTP
 *   (`origin: "cloud"`);
 * - 本机 sidecar → its in-process hub, drained onto the stdio link and pushed by
 *   the main process (`window.sidecarApi.onFulfillFrame`); settles over the
 *   sidecar `respond` RPC (`origin: "sidecar"`).
 *
 * The frame shapes are identical, so one handler serves both — only the settle
 * origin differs, and it is explicit (never guessed from conversation routing).
 */

let unsubscribeCloud: (() => void) | null = null;
let unsubscribeSidecar: (() => void) | null = null;

function requestIdFromCancelFrame(frame: FulfillFrame): string | null {
  if (typeof frame.request_id === "string" && frame.request_id.length > 0) {
    return frame.request_id;
  }
  const payload = frame.payload;
  if (payload && typeof payload === "object") {
    const rid = (payload as { request_id?: unknown }).request_id;
    if (typeof rid === "string" && rid.length > 0) return rid;
  }
  return null;
}

function onFrame(frame: FulfillFrame, origin: InteractionSettleOrigin): void {
  if (frame.type === "ready") return;

  if (frame.type === "client_tool_cancelled") {
    const requestId = requestIdFromCancelFrame(frame);
    if (!requestId) {
      logEvent("warn", "client_tool.cancel_missing_request_id", { origin });
      return;
    }
    cancelClientToolByRequestId(requestId);
    return;
  }

  if (!isClientToolRequiredType(frame.type)) return;

  dispatchClientToolRequired(frame.type, frame.payload, origin);
}

/**
 * Subscribe once for the renderer lifetime (idempotent). Call from `main.tsx`.
 *
 * AppShell only owns start/stop of the cloud transport (`startFulfillStream`);
 * the sidecar push needs no transport of its own (the stdio link is the turn's).
 */
export function installClientToolIngress(): void {
  if (!unsubscribeCloud) {
    unsubscribeCloud = onFulfillFrame((frame) => onFrame(frame, "cloud"));
  }
  if (!unsubscribeSidecar) {
    unsubscribeSidecar =
      window.sidecarApi?.onFulfillFrame?.((push) =>
        onFrame(push.frame, "sidecar"),
      ) ?? null;
  }
}

/** Test-only: drop the ingress subscriptions. */
export function resetClientToolIngressForTests(): void {
  unsubscribeCloud?.();
  unsubscribeCloud = null;
  unsubscribeSidecar?.();
  unsubscribeSidecar = null;
}
