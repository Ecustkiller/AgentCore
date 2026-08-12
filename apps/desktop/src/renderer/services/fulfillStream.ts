import { isWebRuntime } from "@/lib/capabilities";
import { clientHeaders } from "@/lib/clientBuildInfo";
import {
  BASE_URL,
  api,
  getCsrfHeaders,
  notifyUnauthorized,
  tryRefresh,
} from "@/services/api";
import { getDeviceId } from "@/services/deviceIdentity";

/**
 * Device-level fulfill firehose client (`GET /v1/fulfill`).
 *
 * Long-lived SSE carries CLIENT_TOOL `*_required` frames (and
 * `client_tool_cancelled`) to the machine that can actually run them — independent
 * of which conversation SSE the UI is watching. Mirrors {@link startRealtime}'s
 * transport posture (401→refresh→reconnect, capped exponential backoff, catch-up
 * on each live connect) but is a **separate** connection with `device_id` + caps +
 * roots. Root-set changes POST `/v1/fulfill/roots` without reconnecting.
 *
 * Transport only: op execution / settle is owned by the fulfill consumer (D2)
 * via {@link onFulfillFrame}.
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/** Caps advertised on every connect (comma-joined query param). */
export const FULFILL_CAPS = [
  "workspace",
  "host",
  "mcp",
  "board",
  "board_read",
  "notify",
  "external_mount",
] as const;

/**
 * Parsed fulfill SSE payload.
 * - `{ type: "ready" }` on connect
 * - existing CLIENT_TOOL `*_required` shapes (type string unchanged)
 * - `{ type: "client_tool_cancelled", request_id }`
 */
export type FulfillFrame = {
  type: string;
  request_id?: string;
  payload?: unknown;
  [key: string]: unknown;
};

export type FulfillFrameListener = (frame: FulfillFrame) => void;

type StreamOutcome = "reconnect" | "stop";

let running = false;
let controller: AbortController | null = null;
let reconnectTimer: number | null = null;
let rootsUnsub: (() => void) | null = null;
let attempts = 0;
let cachedDeviceId: string | null = null;
/** Last root ids declared to the server (sorted join for cheap compare). */
let declaredRootsKey = "";
const listeners = new Set<FulfillFrameListener>();

function emitFrame(frame: FulfillFrame): void {
  for (const cb of listeners) {
    try {
      cb(frame);
    } catch {
      /* listener errors must not kill the stream */
    }
  }
}

async function resolveDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const id = await getDeviceId();
  cachedDeviceId = id;
  return id;
}

async function listRootIds(): Promise<string[]> {
  try {
    const roots = (await window.fsApi?.listRoots?.()) ?? [];
    return roots
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
  } catch {
    return [];
  }
}

function rootsKey(ids: string[]): string {
  return ids.join(",");
}

async function postRoots(deviceId: string, roots: string[]): Promise<void> {
  try {
    await api.post("/v1/fulfill/roots", {
      device_id: deviceId,
      roots,
    });
    declaredRootsKey = rootsKey(roots);
  } catch {
    /* best-effort — next grant change / reconnect re-declares */
  }
}

/** Re-declare only when the local root set actually drifted. */
async function syncRootsIfChanged(deviceId: string): Promise<void> {
  const roots = await listRootIds();
  if (rootsKey(roots) === declaredRootsKey) return;
  await postRoots(deviceId, roots);
}

function unsubscribeRootsChanged(): void {
  rootsUnsub?.();
  rootsUnsub = null;
}

/**
 * Re-declare roots when the main process reports a grant added / removed.
 *
 * Event-driven (`fs:rootsChanged`, emitted once the roots file is persisted) —
 * the server's presence gate refuses a local turn whose root nobody declares,
 * so a stale declaration is user-visible.
 */
function subscribeRootsChanged(deviceId: string): void {
  unsubscribeRootsChanged();
  const subscribe = window.fsApi?.onRootsChanged;
  if (!subscribe) return;
  rootsUnsub = subscribe(() => {
    if (!running) return;
    void syncRootsIfChanged(deviceId);
  });
}

/** Catch-up: force re-declare roots after (re)connect (hub dropped prior session). */
function catchUp(deviceId: string): void {
  void (async () => {
    const roots = await listRootIds();
    await postRoots(deviceId, roots);
  })();
}

/** Parse one SSE frame and fan out to listeners (skips heartbeat comments). */
function handleFrame(frame: string): void {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  try {
    const event = JSON.parse(dataLines.join("\n")) as FulfillFrame;
    if (typeof event?.type !== "string" || !event.type) return;
    emitFrame(event);
  } catch {
    /* malformed frame — skip */
  }
}

function buildFulfillUrl(deviceId: string, roots: string[]): string {
  const params = new URLSearchParams();
  params.set("device_id", deviceId);
  params.set("caps", FULFILL_CAPS.join(","));
  params.set("roots", roots.join(","));
  return `${BASE_URL}/v1/fulfill?${params.toString()}`;
}

async function runStream(
  signal: AbortSignal,
  deviceId: string,
): Promise<StreamOutcome> {
  const roots = await listRootIds();
  let response: Response;
  try {
    response = await fetch(buildFulfillUrl(deviceId, roots), {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "text/event-stream",
        ...clientHeaders(),
        ...getCsrfHeaders("GET"),
      },
      signal,
    });
  } catch {
    return "reconnect";
  }

  if (response.status === 401) {
    const outcome = await tryRefresh();
    if (outcome === "renewed" || outcome === "transient") return "reconnect";
    notifyUnauthorized();
    return "stop";
  }
  if (!response.ok || !response.body) return "reconnect";

  // Connected: reset backoff, catch-up POST roots, then track grant changes
  // (root changes re-declare via POST — no reconnect).
  attempts = 0;
  declaredRootsKey = rootsKey(roots);
  catchUp(deviceId);
  subscribeRootsChanged(deviceId);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) handleFrame(frame);
    }
  } catch {
    return "reconnect";
  }
  return "reconnect";
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  attempts += 1;
  reconnectTimer = window.setTimeout(
    () => {
      reconnectTimer = null;
      void connect();
    },
    delay + Math.random() * 500,
  );
}

async function connect(): Promise<void> {
  if (!running) return;
  let deviceId: string;
  try {
    deviceId = await resolveDeviceId();
  } catch {
    // No durable identity (web / missing preload) — do not loop.
    running = false;
    return;
  }
  const ac = new AbortController();
  controller = ac;
  let outcome: StreamOutcome = "reconnect";
  try {
    outcome = await runStream(ac.signal, deviceId);
  } catch {
    outcome = "reconnect";
  }
  unsubscribeRootsChanged();
  if (ac.signal.aborted || !running) return;
  if (outcome === "stop") {
    running = false;
    return;
  }
  scheduleReconnect();
}

/** Open the fulfill firehose for the current session (idempotent). Web no-op. */
export function startFulfillStream(): void {
  if (isWebRuntime()) return;
  if (running) return;
  running = true;
  attempts = 0;
  void connect();
}

/** Close the fulfill firehose and cancel pending reconnect / polls (idempotent). */
export function stopFulfillStream(): void {
  running = false;
  unsubscribeRootsChanged();
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}

/**
 * Subscribe to parsed fulfill frames (`ready`, `*_required`, `client_tool_cancelled`).
 * Returns an unsubscribe function.
 */
export function onFulfillFrame(cb: FulfillFrameListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test-only: reset module state between cases. */
export function resetFulfillStreamForTests(): void {
  stopFulfillStream();
  attempts = 0;
  cachedDeviceId = null;
  declaredRootsKey = "";
  listeners.clear();
}
