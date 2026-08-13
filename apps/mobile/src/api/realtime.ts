// 每用户 firehose（`GET /v1/realtime`）—— 手机 Bearer 客户端（前端技术与架构 §七）。
//
// 一条长连接承载「与当前打开的对话无关」的推送。本刀只消费 `ai_attention`（某个对话停下来
// 等人 / 已放行），其余事件类型（chat_message / presence / friend_request …）一律 no-op：
// 人际 IM 仍走它自己的轮询，接 firehose 不等于顺手重构 IM。
//
// 与对话流 (api/stream.ts) 的两点不同：帧是扁平事件对象（`data: {type, …}`），不是 turn 流
// 的 `{type,timestamp,payload}` envelope；且没有 `id:` / Last-Event-ID 断点续传——尽力而为的
// 通知面，断线期间漏掉的帧补不回来（提醒条的兜底见 lib/aiAttention.ts）。
//
// SSE 中途换不了 token，所以沿用共享的 401 策略（fetchWithAuthRefresh：刷一次 + 重放，仍
// 401 就清 token）；传输层掉线按指数退避重连，节奏对齐 browserLive。
import {
  apiUrl,
  authHeader,
  fetchWithAuthRefresh,
  getTokens,
} from "@/api/client";
import { type AiAttentionEvent, applyAiAttention } from "@/lib/aiAttention";
import { clientHeaders } from "@/lib/clientBuildInfo";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** 后端每 25s 发一次 `: keep-alive`，所以彻底静默 = socket 已死（对齐 stream.ts 的空闲看门狗）。 */
const IDLE_TIMEOUT_MS = 60_000;

type StreamOutcome = "reconnect" | "stop";

let running = false;
let controller: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;

function handleFrame(frame: string): void {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return; // 心跳注释 / 只有 event: 行
  let event: { type?: string };
  try {
    event = JSON.parse(dataLines.join("\n")) as { type?: string };
  } catch {
    return; // 坏帧
  }
  if (event.type === "ai_attention") {
    applyAiAttention(event as AiAttentionEvent);
  }
  // `ready` 与其余事件类型：本刀不消费。
}

async function pump(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // 空闲看门狗按「每次读」计时（不是总时长上限）：静默超时就取消读，让外层走重连。
  const readChunk = (): ReturnType<typeof reader.read> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new Error("realtime idle"));
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
      fetch(apiUrl("/v1/realtime"), {
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
    // 策略已经刷过 + 重放过（仍 401 会清 token）。会话真死 → 停；只是刷失败 → 退避重试。
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
 * 开 firehose（幂等）。没有会话时直接 no-op，所以生命周期钩子可以无脑调用——
 * 登出后回前台不会误开一条注定 401 的连接。
 */
export function startRealtime(): void {
  if (running || !getTokens()) return;
  running = true;
  attempts = 0;
  void connect();
}

/** 关 firehose 并取消待重连（幂等）。 */
export function stopRealtime(): void {
  running = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}
