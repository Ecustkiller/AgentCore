/**
 * Sidecar IPC 契约 —— 主进程 / preload / renderer 三端共享的单一真相源。
 *
 * sidecar（双模式工作区 / 远期规划 §一.1）是跑在用户本机的 Python 进程，**托管同一个
 * 运行时引擎**：桌面 spawn `python -m agentcore.sidecar`，经 stdio JSON-RPC 驱动它，
 * 一个回合完全在本机执行（文件 / 代码直接碰真实本地盘，不再每个 op 经 `WorkspaceChannel`
 * 往返云端）。
 *
 * 本文件只定义「主进程 ↔ renderer」这一段 IPC 的形状；主进程内部再把它翻译成与 Python
 * sidecar 之间的 JSON-RPC（见 `main/sidecar-service.ts`）。两侧字段刻意对齐 Python 端
 * `agentcore/sidecar/server.py` 的参数 / 返回，避免契约漂移。
 *
 * 与 `ipc-contract.ts`（本地文件系统）分文件：那是「云端引擎遥控桌面执行 op」的通道，
 * 本文件是「引擎本体就在本地」的通道，两者是双模式的两条独立链路。
 */

/** 一次回合的云代理推理凭据：把引擎的 LLM 调用指向云端推理代理（平台 key 不下放本机）。 */
export interface SidecarInference {
  baseUrl: string;
  apiKey: string;
}

/** renderer 发起一次本地回合所需的入参（主进程据此驱动对应 root 的 sidecar）。 */
export interface SidecarStartTurnRequest {
  /** 目标会话 id —— 回流的 `turn/event` 用它定位 renderer 侧的会话切片。 */
  conversationId: string;
  /** 绑定的本地授权根 id（主进程据此解析绝对路径并复用 / 拉起该根的 sidecar）。 */
  rootId: string;
  /** 本回合 id（cancel 的寻址键；renderer 自行铸造，需在该 sidecar 内唯一）。 */
  turnId: string;
  /** 用户本轮消息正文。 */
  userMessage: string;
  /**
   * 先前对话历史（`{role, content}` 列表）。云模式由服务端从库里取；sidecar 无库
   * （Slice 1 的 `ConversationStore` 为 no-op），故由 renderer 从本地会话切片喂入。
   */
  history?: SidecarHistoryEntry[];
  /** 云代理凭据；缺省则 sidecar 回退到其自身 server 配置（dev 便利，非生产姿态）。 */
  inference?: SidecarInference;
}

/** 一条历史消息（与引擎 `run_chat_pipeline` 的 history 形状对齐）。 */
export interface SidecarHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/** 一条 web 来源（**严格**对齐服务端 `Citation` schema：四字段恒在，缺省为空串）。
 *  renderer 原样转发给 `POST .../local-turns` 落库，故须与生成类型逐字段同形。 */
export interface SidecarCitation {
  url: string;
  title: string;
  snippet: string;
  site: string;
}

/** 回合回放载荷（**严格**对齐服务端 `RunsPayload` schema：多 Agent 团队图事件 + 单 Agent
 *  思考·工具时间线）。renderer **原样**转发给云端落库，自身不解读；字段可选性与生成类型一致。 */
export interface SidecarRunsPayload {
  events?: Record<string, unknown>[];
  finish_reason?: string | null;
  process?: Record<string, unknown>[] | null;
}

/**
 * 一行已定价的 per-run 成本账（与服务端 `CostRunPayload` / `asdict(RunCost)` 同形）。
 *
 * 刻意用 snake_case 对齐服务端 schema——renderer 把它**原样**转发给 `POST .../local-turns`
 * 落入 `cost_events`，全程不解读字段。计费信任边界见 `streamConversationViaSidecar`。
 */
export interface SidecarCostRun {
  run_id: string;
  parent_run_id: string | null;
  agent_id: string | null;
  role: string;
  model: string;
  tokens: Record<string, number>;
  cost: Record<string, number>;
  cost_total_nano: number;
  currency: string;
  rounds: number;
  duration_ms: number;
}

/** 一次回合的最终结果（startTurn 的延迟响应——流式细节已由 `turn/event` 给过）。 */
export interface SidecarTurnResult {
  turnId: string;
  messageId: string | null;
  content: string;
  reasoningContent: string | null;
  finishReason: string;
  rounds: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  /** 助手回复的 web 来源（落库到 assistant 消息）。 */
  citations: SidecarCitation[];
  /** 回放载荷（团队图 / 思考·工具时间线）；纯聊天回合为 null。 */
  runs: SidecarRunsPayload | null;
  /** 已定价的 per-run 成本账（落 `cost_events`，按 run_id 幂等）。 */
  costRuns: SidecarCostRun[];
  error: string | null;
}

/**
 * 主进程 → renderer 的回合事件推送。`event` 与服务端 SSE 的事件同形状
 * （`@/types/events` 的 `SSEEvent`），故 renderer 可把它**原样**喂给同一个
 * `dispatchSSEEvent`——云 / 本地两条链路共用一套事件处理，零额外分支。
 */
export interface SidecarEventPush {
  conversationId: string;
  turnId: string;
  event: {
    type: string;
    /** ISO-8601 字符串（与引擎 `SSEEvent.timestamp` 一致，便于原样喂 `dispatchSSEEvent`）。 */
    timestamp: string;
    payload: unknown;
  };
}

/** 主进程 → renderer 的 sidecar 生命周期/诊断推送（拉起失败、退出等）。 */
export interface SidecarStatusPush {
  rootId: string;
  /** spawned=已拉起并初始化；exited=进程退出；error=拉起/通信失败。 */
  phase: "spawned" | "exited" | "error";
  /** 人类可读说明（error/exited 时带原因，用于 UI 降级提示与排查）。 */
  detail?: string;
}

/** 结算一个被挂起的交互（审批 / ask_user / 本地工具）——经 sidecar 的 `respond` 方法。 */
export interface SidecarRespondRequest {
  rootId: string;
  /** 被挂起交互的 id（即引擎 `ClientRequestBridge` 发出的 requestId）。 */
  requestId: string;
  conversationId: string;
  /** 该交互的应答载荷（形状随交互类型而定）。 */
  result: unknown;
}

/** 取消一个在跑的回合。 */
export interface SidecarCancelRequest {
  rootId: string;
  turnId: string;
}

/** IPC 通道名 —— 主进程与 preload 共用，避免硬编码漂移。 */
export const SIDECAR_CHANNELS = {
  startTurn: "sidecar:startTurn",
  cancel: "sidecar:cancel",
  respond: "sidecar:respond",
  event: "sidecar:event",
  status: "sidecar:status",
} as const;

/**
 * 暴露在 `window.sidecarApi` 上的 renderer 端 API 面。
 *
 * `startTurn` 的 Promise 在**回合结束**时才 resolve（携带最终结果）；过程中的流式
 * 事件经 `onEvent` 推来。失败（拉起不了 sidecar / 引擎异常）以 reject 抛出，调用方
 * 据此降级（如退回云模式或提示）。
 */
export interface SidecarApi {
  startTurn(req: SidecarStartTurnRequest): Promise<SidecarTurnResult>;
  cancel(req: SidecarCancelRequest): Promise<void>;
  respond(req: SidecarRespondRequest): Promise<void>;
  /** 订阅本回合事件流；返回取消订阅函数。 */
  onEvent(cb: (e: SidecarEventPush) => void): () => void;
  /** 订阅 sidecar 生命周期/诊断事件；返回取消订阅函数。 */
  onStatus(cb: (e: SidecarStatusPush) => void): () => void;
}
