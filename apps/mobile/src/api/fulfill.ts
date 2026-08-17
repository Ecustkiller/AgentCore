// 账号级 observer（`GET /v1/fulfill`）—— 手机 Bearer 客户端。
//
// 手机不履约本地 op：空 caps / 空 roots，只收账号态。本刀只消费
// `ai_turn_activity_snapshot` / `ai_turn_activity`（抽屉 running 灯；running
// 另 bump 列表位次，done 不 bump），其余帧（queue / attention / CLIENT_TOOL /
// ready）一律 no-op。禁止把 running 接到 realtime。
//
// `device_id` 每次进程 `mobile-${uuid}`，勿落盘——对齐桌面 web 的 `web-${uuid}`：
// hub 按 (user, device_id) 一台一条，落盘会让多开互踢。
//
// 鉴权 / 重连 / 空闲看门狗与 realtime.ts 同姿态（Bearer、`fetchWithAuthRefresh`、
// 无 token 不开）。SSE 中途换不了 token。
import {
  apiUrl,
  authHeader,
  fetchWithAuthRefresh,
  getTokens,
} from "@/api/client";
import {
  AI_TURN_ACTIVITY_SNAPSHOT_TYPE,
  AI_TURN_ACTIVITY_TYPE,
  applyAiTurnActivity,
  applyAiTurnActivitySnapshot,
} from "@/lib/aiTurnActivity";
import { clientHeaders } from "@/lib/clientBuildInfo";
import { bumpActivity } from "@/lib/conversationListCache";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** 后端每 25s 发一次 `: keep-alive`，所以彻底静默 = socket 已死（对齐 realtime.ts）。 */
const IDLE_TIMEOUT_MS = 60_000;

type StreamOutcome = "reconnect" | "stop";

let running = false;
let controller: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
/** Observer 连接 id，首次 connect 铸造（null = 尚未铸造）。进程内复用，不落盘。 */
let observerId: string | null = null;

function observerConnectionId(): string {
  if (!observerId) observerId = `mobile-${crypto.randomUUID()}`;
  return observerId;
}

function fulfillUrl(deviceId: string): string {
  const params = new URLSearchParams();
  params.set("device_id", deviceId);
  params.set("caps", "");
  params.set("roots", "");
  return apiUrl(`/v1/fulfill?${params.toString()}`);
}

function bumpListIfRunning(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as { conversation_id?: unknown; state?: unknown };
  if (p.state === "running" && typeof p.conversation_id === "string") {
    bumpActivity(p.conversation_id);
  }
}

function handleFrame(frame: string): void {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return; // 心跳注释 / 只有 event: 行
  let event: { type?: string; payload?: unknown };
  try {
    event = JSON.parse(dataLines.join("\n")) as {
      type?: string;
      payload?: unknown;
    };
  } catch {
    return; // 坏帧
  }
  if (event.type === AI_TURN_ACTIVITY_SNAPSHOT_TYPE) {
    applyAiTurnActivitySnapshot(event.payload);
    return;
  }
  if (event.type === AI_TURN_ACTIVITY_TYPE) {
    applyAiTurnActivity(event.payload);
    bumpListIfRunning(event.payload);
  }
  // queue / attention / CLIENT_TOOL / ready：本刀不消费。
}

async function pump(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readChunk = (): ReturnType<typeof reader.read> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new Error("fulfill idle"));
      }, IDLE_TIMEOUT_MS);
      reader.read().then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  while (true) {
    const { done, value } = await readChunk();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) handleFrame(frame);
  }
}

async function runStream(signal: AbortSignal): Promise<StreamOutcome> {
  let response: Response;
  try {
    response = await fetchWithAuthRefresh(() =>
      fetch(fulfillUrl(observerConnectionId()), {
        method: "GET",
        headers: {
          ...clientHeaders(),
          Accept: "text/event-stream",
          ...authHeader(),
        },
        signal,
      }),
    );
  } catch {
    return "reconnect"; // 传输失败（离线 / 已 abort）
  }

  if (response.status === 401) {
    return getTokens() ? "reconnect" : "stop";
  }
  if (!response.ok || !response.body) return "reconnect";

  attempts = 0;
  try {
    await pump(response.body);
  } catch {
    return "reconnect"; // 读错误 / 空闲超时（含 abort，由 connect 判信号）
  }
  return "reconnect"; // 服务端关流
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  attempts += 1;
  reconnectTimer = setTimeout(
    () => {
      reconnectTimer = null;
      void connect();
    },
    delay + Math.random() * 500,
  );
}

async function connect(): Promise<void> {
  if (!running) return;
  const ac = new AbortController();
  controller = ac;
  let outcome: StreamOutcome = "reconnect";
  try {
    outcome = await runStream(ac.signal);
  } catch {
    outcome = "reconnect";
  }
  if (ac.signal.aborted || !running) return;
  if (outcome === "stop") {
    running = false;
    return;
  }
  scheduleReconnect();
}

/**
 * 开 observer（幂等）。没有会话时直接 no-op，所以生命周期钩子可以无脑调用——
 * 登出后回前台不会误开一条注定 401 的连接。
 */
export function startFulfill(): void {
  if (running || !getTokens()) return;
  running = true;
  attempts = 0;
  void connect();
}

/** 关 observer 并取消待重连（幂等）。不清 running 表——重连靠下一帧 snapshot 替换。 */
export function stopFulfill(): void {
  running = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}

/** Test-only: 关掉连接并丢掉进程内 device_id。 */
export function __resetFulfillForTests(): void {
  stopFulfill();
  attempts = 0;
  observerId = null;
}
