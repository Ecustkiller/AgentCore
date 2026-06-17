import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import { getRuntime } from "@/stores/conversation";
import type { SidecarHistoryEntry } from "@shared/sidecar-contract";

/**
 * 会话路由判定：一个回合该走本地 sidecar，还是云端 SSE。
 *
 * 双模式工作区 / 远期规划 §一.1。**关键约束**：当前「local 模式」已可用——走的是
 * 云链路（云端引擎遥控桌面，发 `workspace_op_required` 让桌面执行 op），且**有服务端
 * 持久化与计费**。Slice 1 的 sidecar 这两样还是 no-op，故**不能**无条件把所有 local
 * 会话改路由到 sidecar，否则会静默丢掉它们的持久化/计费。
 *
 * 因此 sidecar 路由是**显式 opt-in**（dev 开关 `VITE_SIDECAR=1`，默认关）：仅当开关开、
 * 会话绑定了本机存在的本地根、且本回合无附件时才走 sidecar；其余一律维持现状云链路。
 * 这样既能让本地引擎在 UI 真跑起来联调，又不动既有 local 会话的行为。
 */

/**
 * 当前正经 sidecar 跑回合的会话 → 其本地根 id 的映射。
 *
 * 一个挂起的交互（审批 / ask_user / plan_review）由统一入口 `resolveInteraction` 结算；
 * 它据此判断「本会话此刻是不是 sidecar 回合」——是则把结算改走 `window.sidecarApi.respond`
 * 回这条 stdio 链路（够到 sidecar 进程内的 `InteractionRegistry`），而非云端 HTTP（够不到）。
 * 由 `streamConversationViaSidecar` 在回合起止时登记 / 注销。
 */
const activeSidecarTurns = new Map<string, string>();

/** 登记：该会话此刻在某本地根上跑 sidecar 回合（回合开始时调）。 */
export function setActiveSidecarTurn(
  conversationId: string,
  rootId: string,
): void {
  activeSidecarTurns.set(conversationId, rootId);
}

/** 注销：该会话的 sidecar 回合已结束（回合 finally 调）。 */
export function clearActiveSidecarTurn(conversationId: string): void {
  activeSidecarTurns.delete(conversationId);
}

/** 该会话此刻在跑的 sidecar 本地根 id；非 sidecar 回合则 null。 */
export function getActiveSidecarRoot(conversationId: string): string | null {
  return activeSidecarTurns.get(conversationId) ?? null;
}

/** sidecar 路由是否启用（dev 开关 + 桌面环境）。 */
export function isSidecarEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.sidecarApi &&
    import.meta.env.VITE_SIDECAR === "1"
  );
}

/**
 * 解析一个会话应在其上跑 sidecar 的本地根 id；不该走 sidecar 则返回 null。
 *
 * 取「会话 → 文件夹 → `localRootId`」（文件夹即工作区，绑定挂在文件夹上），再核对该根
 * **确在本机**（否则属 §八「路径不存在」降级，交回云链路处理）。开关关 / 裸聊无文件夹 /
 * 云端文件夹 → null。
 */
export async function resolveSidecarRoot(
  conversationId: string,
): Promise<string | null> {
  if (!isSidecarEnabled()) return null;
  const folderId =
    getConversations().find((c) => c.id === conversationId)?.folderId ?? null;
  if (!folderId) return null;
  const rootId =
    getFolders().find((f) => f.id === folderId)?.localRootId ?? null;
  if (!rootId) return null;
  // 仅当该根确在本机才走 sidecar（缺失则交回云端，由模式栏走重连/切云降级）。
  const roots = await window.fsApi.listRoots();
  return roots.some((r) => r.id === rootId) ? rootId : null;
}

/**
 * 从本地会话切片重建喂给 sidecar 的历史（`{role, content}` 列表）。
 *
 * sidecar 无库（Slice 1 `ConversationStore` 为 no-op），故先前轮次的上下文须由
 * renderer 喂入。取 `uptoUserId`（本回合用户消息）**之前**的 user/assistant 消息，
 * 滤掉流式中与空内容的气泡。
 */
export function buildSidecarHistory(
  conversationId: string,
  uptoUserId: string,
): SidecarHistoryEntry[] {
  const messages = getRuntime(conversationId).messages;
  const idx = messages.findIndex((m) => m.id === uptoUserId);
  const prior = idx >= 0 ? messages.slice(0, idx) : messages;
  return prior
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        !m.isStreaming &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}
