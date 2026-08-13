import { isWebRuntime } from "@/lib/capabilities";
import { clientHeaders } from "@/lib/clientBuildInfo";
import {
  BASE_URL,
  api,
  getCsrfHeaders,
  notifyUnauthorized,
  tryRefresh,
} from "@/services/api";
import {
  getDeviceId,
  resetDeviceIdentityForTests,
} from "@/services/deviceIdentity";

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
/** Last root ids declared to the server (sorted join for cheap compare). */
let declaredRootsKey = "";
/** Last root set actually read off the main process (`null` = never read one). */
let lastKnownRoots: string[] | null = null;
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

/**
 * Outcome of reading the local grant set. `ok: false` means **unknown**, which
 * is not the same fact as "this device holds no root".
 */
type RootsRead = { ok: true; roots: string[] } | { ok: false };

/**
 * Read the authorized root ids from the main process.
 *
 * A rejected / unavailable read must never surface as `[]`: declaring the empty
 * set tells the hub this device fulfils nothing rooted, and — because
 * re-declaration is grant-event driven — that verdict stands until the user
 * happens to touch their grants. Callers act on `ok: false` by leaving the
 * standing declaration alone.
 */
async function readRootIds(): Promise<RootsRead> {
  try {
    const fsApi = window.fsApi;
    if (!fsApi?.listRoots) throw new Error("fsApi.listRoots 不可用");
    const roots = await fsApi.listRoots();
    if (!Array.isArray(roots)) throw new Error("fs:listRoots 返回了非数组");
    const ids = roots
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
    lastKnownRoots = ids;
    return { ok: true, roots: ids };
  } catch (err) {
    console.warn("[fulfill] 读取本地授权根失败：维持既有声明，不声明空集", err);
    return { ok: false };
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
  const read = await readRootIds();
  if (!read.ok) return;
  if (rootsKey(read.roots) === declaredRootsKey) return;
  await postRoots(deviceId, read.roots);
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

/**
 * Catch-up: force re-declare roots after (re)connect (hub dropped prior session),
 * picking up a grant change that landed before the change subscription existed.
 * An unreadable grant set leaves the connect-time declaration standing.
 */
function catchUp(deviceId: string): void {
  void (async () => {
    const read = await readRootIds();
    if (!read.ok) return;
    await postRoots(deviceId, read.roots);
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
  // `hub.register` replaces this device's session with whatever `roots` carries,
  // so an unreadable grant set re-declares the last one we actually saw rather
  // than retracting roots the device can still fulfil. Stale ids cost nothing:
  // the main process re-authorizes every op against the real grant store.
  const read = await readRootIds();
  const roots = read.ok ? read.roots : (lastKnownRoots ?? []);
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
    deviceId = await getDeviceId();
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
  resetDeviceIdentityForTests();
  declaredRootsKey = "";
  lastKnownRoots = null;
  listeners.clear();
}
