import {
  getRuntime,
  lastAssistantProjectionId,
  useConversationStore,
} from "@/stores/conversation";
import {
  execRuntime,
  isConversationExecutionLive,
  useExecutionStore,
} from "@/stores/execution";

export type MessageDelivery = "steer" | "queue";

/**
 * 协调活跃 ≈ 当前回合已有团队 plan（run_plan）。
 * 发送路径 snapshot 即可；按钮布局须走 {@link useCoordinationActive}。
 */
export function isCoordinationActive(
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) return false;
  const key = lastAssistantProjectionId(getRuntime(conversationId).messages);
  if (!key) return false;
  return Boolean(useExecutionStore.getState().byId[key]?.plan);
}

/** 订阅最新助手泡是否已有 plan；ingestPlan 后按钮布局要跟着换，不能只 getState。 */
export function useCoordinationActive(): boolean {
  const lastKey = useConversationStore((s) => {
    const id = s.currentConversationId;
    if (!id) return null;
    return lastAssistantProjectionId(s.byId[id]?.messages ?? []);
  });
  return useExecutionStore((s) =>
    lastKey ? Boolean(s.byId[lastKey]?.plan) : false,
  );
}

/**
 * 这桌还有活队：协作图仍在转（含主管已写出一段但仍在听团）。
 * 发送门跟队走，不跟「助手泡看起来写完了」。
 */
export function isLiveCoordinatingTurn(
  conversationId: string | null | undefined,
): boolean {
  if (!conversationId) return false;
  const key = lastAssistantProjectionId(getRuntime(conversationId).messages);
  if (!key) return false;
  const rt = useExecutionStore.getState().byId[key];
  return rt ? isConversationExecutionLive(rt) : false;
}

/** 订阅最新助手泡的协作图是否还在转。 */
export function useLiveCoordinatingTurn(): boolean {
  const lastKey = useConversationStore((s) => {
    const id = s.currentConversationId;
    if (!id) return null;
    return lastAssistantProjectionId(s.byId[id]?.messages ?? []);
  });
  return useExecutionStore((s) =>
    lastKey ? isConversationExecutionLive(execRuntime(s, lastKey)) : false,
  );
}

/**
 * 默认 delivery：
 * - 空闲 → steer
 * - 经典生成中（无团队图）→ queue（主发送 / Enter）
 * - 协调空窗（已有团队图且队还在，含听团）→ steer（立刻给主 Agent）
 * 经典显式插队（Ctrl/Cmd+Enter / 「插队」）传 ``delivery=steer``。
 * 协调空窗显式排队（次级「排队」/ Ctrl/Cmd+Enter）传 ``delivery=queue``。
 * 不可注入时由服务端降级 ``turn_queued`` + ``degraded_from=steer``。
 */
export function resolveDefaultDelivery(
  isGenerating: boolean,
  conversationId: string | null | undefined,
): MessageDelivery {
  if (!isGenerating) return "steer";
  return isCoordinationActive(conversationId) ? "steer" : "queue";
}
