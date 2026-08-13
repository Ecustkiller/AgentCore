/**
 * 对话级订阅（云对话多端同权 B2 · P0-b · 验收 4）。
 *
 * 回合级 attach 绑的是**回合**：空闲对话拿 204，此后另一端发送 / 队列 drain /
 * 冷 resume 唤醒 / stage_card 起的每个新回合都是新 sink，拿过 204 的这端零信号。
 * 这里改订**对话**：``GET …/stream?follow=true`` 空闲时只收心跳保持连接，之后每个
 * 新回合在同一条流上自动重放 + 跟播，桌面停在空闲对话上也能自动出现新回合。
 *
 * 三条边界：
 *
 * - **不与本端自有连接同折一个回合**。本端 POST 回合流 / 回合级 attach / midFlight
 *   排队连接一开，这条订阅立刻让位（关流），闲下来再自动连回——重连时服务端整段重放
 *   当前 live run，所以让位期间漏掉的帧会补齐。互斥闸见 ``streamOwnership`` 的
 *   ``beginLocalConversationStream``。
 * - **空闲不是「生成中」**。真空闲时本模块一个 store 都不写：不开气泡、不置
 *   ``isGenerating``、不占 abort 槽，也不因掉线弹横幅（后台观察者，静默退避重连）。
 * - **切会话不硬卸正在跟播的泵**（对齐 ``hydrateAttachSettle`` 的既有设计）：切走时
 *   若正跟着一个回合，等它收口的下一个心跳再关，否则气泡会冻在流式态。
 *
 * SSE 只带回合事件、**不带用户消息正文**，所以另一端开的新回合折之前要先把消息窗
 * 拉齐一次，不然屏幕上只会冒出一个没有提问的助手气泡。
 */
import { clientHeaders } from "@/lib/clientBuildInfo";
import { logEvent } from "@/lib/log";
import { BASE_URL, tryRefresh } from "@/services/api";
import { loadLatestWindow } from "@/services/messages";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  ATTACH_CAUGHT_UP_COMMENT,
  flushAttachCatchUp,
  peekLastEventId,
  pumpSseBody,
} from "@/services/streamConversation";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import type { MessageStartPayload, SSEEvent } from "@/types/events";
import { unstable_batchedUpdates } from "react-dom";
import { reconcileQueuedTurns } from "./reconcileQueuedTurns";
import { resetPartialTurnForReplay } from "./recovery";
import {
  hasLocalConversationStream,
  subscribeLocalConversationStream,
} from "./streamOwnership";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type FollowSlot = {
  conversationId: string;
  /** 终止：不再重连，循环退出。 */
  stopped: boolean;
  /** 已请求关闭但正在跟播 → 等回合收口的下一个心跳再真关。 */
  closeWhenIdle: boolean;
  /** 本端自有连接占用中 → 让位；闲下来由订阅回调唤醒。 */
  suspended: boolean;
  attempts: number;
  ac: AbortController | null;
  unsubBusy: () => void;
  /** 唤醒当前的等待（退避 sleep / 让位挂起）。 */
  wake: (() => void) | null;
};

const slots = new Map<string, FollowSlot>();

/** 本端自有连接一开就 abort 掉订阅；帧的丢弃另由 ``slot.suspended`` 同步兜住
 * （abort 只让读循环报错，已解码进微任务的那一片仍会回调）。 */
function onLocalStreamBusy(slot: FollowSlot, busy: boolean): void {
  slot.suspended = busy;
  if (busy) {
    slot.ac?.abort();
    return;
  }
  slot.wake?.();
}

function wakeSlot(slot: FollowSlot): void {
  slot.wake?.();
}

function sleep(slot: FollowSlot, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      slot.wake = null;
      resolve();
    }, ms);
    slot.wake = () => {
      clearTimeout(timer);
      slot.wake = null;
      resolve();
    };
  });
}

function waitUntilResumable(slot: FollowSlot): Promise<void> {
  if (slot.stopped || !slot.suspended) return Promise.resolve();
  return new Promise<void>((resolve) => {
    slot.wake = () => {
      slot.wake = null;
      resolve();
    };
  });
}

function stopSlot(slot: FollowSlot, reason: string): void {
  if (slot.stopped) return;
  slot.stopped = true;
  slot.unsubBusy();
  slot.ac?.abort();
  slot.ac = null;
  wakeSlot(slot);
  if (slots.get(slot.conversationId) === slot) {
    slots.delete(slot.conversationId);
  }
  logEvent("info", "conversation.follow_closed", {
    conversation_id: slot.conversationId,
    reason,
  });
}

/** 切走 / 切到本机引擎会话：正在跟播就先记账，等回合收口再关。 */
function requestStopSlot(slot: FollowSlot): void {
  if (slot.stopped) return;
  if (getRuntime(slot.conversationId).isGenerating) {
    slot.closeWhenIdle = true;
    return;
  }
  stopSlot(slot, "switched_away");
}

/** 心跳时兑现待关：此刻没有帧在流动，收口后关掉不会冻住气泡。 */
function honorDeferredClose(slot: FollowSlot): void {
  if (!slot.closeWhenIdle || slot.stopped) return;
  if (getRuntime(slot.conversationId).isGenerating) return;
  stopSlot(slot, "deferred_switch_away");
}

function segmentTurnId(segment: SSEEvent[]): string | undefined {
  const start = segment.find((e) => e.type === "message_start");
  return start
    ? ((start.payload as MessageStartPayload).message_id ?? undefined)
    : undefined;
}

/**
 * 这段 catch-up 是不是本端**已经在跟**的那个回合？
 *
 * 是 → 让位重连 / 刷新回来的整段重放，必须 clear-then-fold（否则正文会被追加两遍）。
 * 否 → 另一端开的回合（或本端挂着的过期气泡），走「拉齐窗口再折」。
 */
function holdsSegmentTurn(
  conversationId: string,
  segment: SSEEvent[],
): boolean {
  const rt = getRuntime(conversationId);
  if (!rt.isGenerating) return false;
  const turnId = segmentTurnId(segment);
  if (!turnId) return true; // 无 message_start 的续播段 = 当前回合的后续
  const tail = [...rt.messages].reverse().find((m) => m.role === "assistant");
  return !!tail && (tail.serverMessageId === turnId || tail.id === turnId);
}

async function foldCatchUpSegment(
  slot: FollowSlot,
  segment: SSEEvent[],
): Promise<void> {
  const conversationId = slot.conversationId;
  if (holdsSegmentTurn(conversationId, segment)) {
    unstable_batchedUpdates(() => {
      resetPartialTurnForReplay(conversationId);
      flushAttachCatchUp(conversationId, segment);
    });
    return;
  }
  // 另一端开的新回合：先把消息窗拉齐，用户那条提问只在 REST 里。挂着的过期
  // 「生成中」先落下，否则整窗写入被 loadLatestWindow 的门禁挡掉。
  if (getRuntime(conversationId).isGenerating) {
    useConversationStore.getState().setGenerating(false, conversationId);
  }
  try {
    await loadLatestWindow(conversationId, { softRefresh: true });
  } catch {
    /* best-effort：窗口没拉到也照样跟播，只是缺那条用户气泡 */
  }
  // 拉窗口期间本端自有连接开张 → 整段交给它重放（它做 clear-then-fold），这里折了只会闪一下。
  if (slot.stopped || slot.suspended) return;
  flushAttachCatchUp(conversationId, segment, { clearPartial: false });
}

type ConnectionOutcome = "ok" | "retry" | "stop";

function followFetch(
  conversationId: string,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    ...clientHeaders(),
  };
  // 连上时若已有 live run，服务端据此走 journal 整段重放（值本身是观察性的）。
  headers["Last-Event-ID"] = peekLastEventId(conversationId) ?? "0";
  return fetch(
    `${BASE_URL}/v1/conversations/${conversationId}/stream?follow=true`,
    { method: "GET", credentials: "include", headers, signal },
  );
}

/**
 * 一条连接的收帧循环。
 *
 * 分段规则跟着服务端 ``_attach_frames``：每个回合 = 重放段 → ``: attach-caught-up``
 * → 直播段。首段整段缓冲到边界再一次性折（避免已完成的 worker 再演一遍
 * running→completed）；此后每见到一个「本端没在跟」的 ``message_start`` 就重新收拢
 * 缓冲，拉齐窗口再折。
 */
async function pumpFollowBody(
  slot: FollowSlot,
  response: Response,
): Promise<void> {
  const conversationId = slot.conversationId;
  const buffer: SSEEvent[] = [];
  let buffering = true;
  let releasing = false;
  /** 在飞的折（拉窗口是异步的）——断流后要等它落地再让外层重连，否则两条连接会交叉折。 */
  let releasePending: Promise<void> | null = null;

  const releaseBuffer = (): void => {
    if (releasing) return;
    releasing = true;
    releasePending = (async () => {
      try {
        const segment = buffer.splice(0);
        if (segment.length > 0 && !slot.stopped && !slot.suspended) {
          await foldCatchUpSegment(slot, segment);
        }
        // 折的过程中（拉窗口是异步的）继续进的帧属于同一回合的续播——按序直折，
        // 不能再当 catch-up 段走一次 clear-then-fold（那会把刚折进去的抹掉）。
        while (buffer.length > 0 && !slot.stopped && !slot.suspended) {
          const next = buffer.shift();
          if (next)
            dispatchSSEEvent(next, { conversationId, source: "server" });
        }
      } finally {
        buffer.length = 0;
        releasing = false;
        buffering = false;
      }
    })();
  };

  const openGate = (): void => {
    if (!buffering || releasing) return;
    if (buffer.length === 0) {
      buffering = false; // 没有 catch-up 段可折（空闲连接 / 已折过）
      return;
    }
    releaseBuffer();
  };

  try {
    await pumpSseBody(
      response,
      conversationId,
      (event) => {
        if (slot.stopped || slot.suspended) return;
        if (buffering) {
          buffer.push(event);
          return;
        }
        // 下一个回合起跑：本端没在跟它 → 收拢缓冲，拉齐窗口再折。
        if (
          event.type === "message_start" &&
          !holdsSegmentTurn(conversationId, [event])
        ) {
          buffering = true;
          buffer.push(event);
          openGate();
          return;
        }
        dispatchSSEEvent(event, { conversationId, source: "server" });
      },
      (comment) => {
        if (slot.stopped) return;
        if (comment === ATTACH_CAUGHT_UP_COMMENT) {
          openGate();
          return;
        }
        // ``: ping`` —— 空闲心跳；此刻没有帧在流动，正好兑现待关。
        honorDeferredClose(slot);
      },
    );
    // 断流时仍压着未折的段（老服务端无边界注释 / 中途掉线）：折掉再走重连。
    if (buffering && !releasing && buffer.length > 0) {
      releaseBuffer();
    }
  } finally {
    // 折是异步的（要先拉消息窗）。不等它落地就回到外层重连，两条连接会交叉折同一回合。
    await releasePending;
  }
}

async function runFollowConnection(
  slot: FollowSlot,
): Promise<ConnectionOutcome> {
  const conversationId = slot.conversationId;
  const ac = new AbortController();
  slot.ac = ac;
  try {
    let response = await followFetch(conversationId, ac.signal);
    if (response.status === 401) {
      const refreshed = await tryRefresh();
      if (refreshed === "auth_dead") return "stop";
      if (refreshed !== "renewed") return "retry";
      response = await followFetch(conversationId, ac.signal);
      if (response.status === 401) return "stop";
    }
    if (response.status === 204) {
      // 服务端不认 ``follow``（旧版）：退回回合级语义，别把 204 当心跳空转重连。
      logEvent("warn", "conversation.follow_unsupported", {
        conversation_id: conversationId,
      });
      return "stop";
    }
    if (response.status === 403 || response.status === 404) {
      return "stop"; // 会话不存在 / 非本人——重试没有意义
    }
    if (!response.ok || !response.body) return "retry";

    slot.attempts = 0;
    logEvent("info", "conversation.follow_open", {
      conversation_id: conversationId,
    });
    // （重）连成功：让位 / 掉线期间的 EPHEMERAL 排队帧可能已漏，GET 权威刷新排队条。
    void reconcileQueuedTurns(conversationId);
    await pumpFollowBody(slot, response);
    return "ok";
  } catch {
    return "retry"; // abort（让位 / 关闭）与传输失败同路：外层按状态决定
  } finally {
    if (slot.ac === ac) slot.ac = null;
  }
}

async function runFollowLoop(slot: FollowSlot): Promise<void> {
  while (!slot.stopped) {
    if (hasLocalConversationStream(slot.conversationId)) {
      slot.suspended = true; // 让位：本端自有连接在折这个会话
      await waitUntilResumable(slot);
      continue;
    }
    slot.suspended = false;
    const outcome = await runFollowConnection(slot);
    if (slot.stopped) return;
    if (outcome === "stop") {
      stopSlot(slot, "server_refused");
      return;
    }
    // 切走后连接自己断了 → 正好收工，不再重连。
    if (slot.closeWhenIdle && !getRuntime(slot.conversationId).isGenerating) {
      stopSlot(slot, "deferred_switch_away");
      return;
    }
    if (slot.suspended) continue; // 让位导致的断流：立刻回到等待，不退避
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** slot.attempts,
      RECONNECT_MAX_MS,
    );
    slot.attempts += 1;
    await sleep(slot, delay + Math.random() * 500);
  }
}

function startSlot(conversationId: string): void {
  const slot: FollowSlot = {
    conversationId,
    stopped: false,
    closeWhenIdle: false,
    suspended: hasLocalConversationStream(conversationId),
    attempts: 0,
    ac: null,
    unsubBusy: () => {},
    wake: null,
  };
  slot.unsubBusy = subscribeLocalConversationStream(conversationId, (busy) =>
    onLocalStreamBusy(slot, busy),
  );
  slots.set(conversationId, slot);
  void runFollowLoop(slot);
}

/**
 * 把对话级订阅移到 ``conversationId``（``null`` = 全关）。幂等：同一会话重复调用不重开流。
 *
 * 同时只留一条订阅——每访问一个会话就多挂一条空闲 SSE 会吃光连接池。切走的那条若正在
 * 跟播则延后到回合收口再关。
 */
export function syncConversationFollow(conversationId: string | null): void {
  if (typeof window !== "undefined" && window.__WEB_PREVIEW__) return;
  for (const slot of [...slots.values()]) {
    if (slot.conversationId !== conversationId) requestStopSlot(slot);
  }
  if (!conversationId) return;
  const existing = slots.get(conversationId);
  if (existing) {
    existing.closeWhenIdle = false; // 切回来 → 撤销待关
    return;
  }
  startSlot(conversationId);
}

/** 硬关全部订阅（登出 / 测试隔离）。 */
export function stopAllConversationFollows(): void {
  for (const slot of [...slots.values()]) stopSlot(slot, "stop_all");
  slots.clear();
}

/** 诊断 / 测试：当前挂着订阅的会话。 */
export function followedConversationIds(): string[] {
  return [...slots.keys()];
}
