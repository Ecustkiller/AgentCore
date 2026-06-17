import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import { getRuntime } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import type { SidecarHistoryEntry } from "@shared/sidecar-contract";

/**
 * 会话路由判定：一个回合该走本地 sidecar，还是云端 SSE。
 *
 * 双模式工作区 / 远期规划 §一.1。**关键约束**：当前「local 模式」默认走云链路（云端引擎
 * 遥控桌面，发 `workspace_op_required` 让桌面执行 op）。sidecar 的持久化 / 计费现经回合结束
 * **回写云端**已闭环（幂等可重试，见 `streamConversationViaSidecar` / `localTurns`），故不再有
 * 「静默丢持久化/计费」之虞；但 sidecar 暂非真离线（LLM 仍经云推理代理）、被委派 worker 强制
 * 走审批门，且是较新的链路，故仍以用户开关 opt-in、不无条件改路由。
 *
 * 因此 sidecar 路由是**显式 opt-in**（用户设置开关「本地引擎」，默认关，见 `设置 → 模型配置`）：
 * 仅当开关开、会话绑定了本机存在的本地根、且本回合无附件时才走 sidecar；其余一律维持现状云
 * 链路。这样把本地引擎做成用户可发现、可控的真能力，又不动既有 local 会话的默认行为。
 */

/**
 * 一次 sidecar 回合的寻址目标：本地容器根 id + 工作区子路径（工作区对称化 D1a）。
 *
 * `subpath` 空 = 该根自身（显式添加的本地项目，现行为）；非空 = 该容器根下懒建的 per 对话
 * 工作区子目录。主进程据 `rootId + subpath` 把 sidecar 进程绑定到 `容器根/子路径`（每个子路径
 * 工作区独立一进程），故子路径工作区的本地引擎跑在自己目录里，而非共享的容器根。
 */
export interface SidecarTarget {
  rootId: string;
  subpath: string;
}

/**
 * 当前正经 sidecar 跑回合的会话 → 其 sidecar 目标（root + subpath）的映射。
 *
 * 一个挂起的交互（审批 / ask_user / plan_review）由统一入口 `resolveInteraction` 结算；
 * 它据此判断「本会话此刻是不是 sidecar 回合」——是则把结算改走 `window.sidecarApi.respond`
 * 回这条 stdio 链路（够到 sidecar 进程内的 `InteractionRegistry`），而非云端 HTTP（够不到）。
 * 子路径随目标一并记下，使 respond 能寻址到正确的（按 root+subpath 起的）sidecar 进程。
 * 由 `streamConversationViaSidecar` 在回合起止时登记 / 注销。
 */
const activeSidecarTurns = new Map<string, SidecarTarget>();

/** 登记：该会话此刻在某 sidecar 目标（root + subpath）上跑回合（回合开始时调）。 */
export function setActiveSidecarTurn(
  conversationId: string,
  rootId: string,
  subpath = "",
): void {
  activeSidecarTurns.set(conversationId, { rootId, subpath });
}

/** 注销：该会话的 sidecar 回合已结束（回合 finally 调）。 */
export function clearActiveSidecarTurn(conversationId: string): void {
  activeSidecarTurns.delete(conversationId);
}

/** 该会话此刻在跑的 sidecar 目标（root + subpath）；非 sidecar 回合则 null。 */
export function getActiveSidecarTarget(
  conversationId: string,
): SidecarTarget | null {
  return activeSidecarTurns.get(conversationId) ?? null;
}

/** sidecar 路由是否启用（用户设置开关「本地引擎」+ 桌面环境）。 */
export function isSidecarEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.sidecarApi &&
    useUIStore.getState().sidecarEnabled
  );
}

/**
 * 解析一个会话应在其上跑 sidecar 的目标（容器根 id + 工作区子路径）；不该走 sidecar 则 null。
 *
 * 取「会话 → 文件夹 → `localRootId` + `localSubpath`」（文件夹即工作区，绑定挂在文件夹上），
 * 再核对该根**确在本机**（否则属 §八「路径不存在」降级，交回云链路处理）。`subpath` 非空时
 * 主进程把 sidecar 绑定到 `容器根/子路径`（工作区对称化 D1a），故懒建的 per 对话本地工作区
 * 也能用本地引擎、且各跑在自己目录里。开关关 / 裸聊无文件夹 / 云端文件夹 → null。
 */
export async function resolveSidecarRoot(
  conversationId: string,
): Promise<SidecarTarget | null> {
  if (!isSidecarEnabled()) return null;
  const folderId =
    getConversations().find((c) => c.id === conversationId)?.folderId ?? null;
  if (!folderId) return null;
  const folder = getFolders().find((f) => f.id === folderId) ?? null;
  const rootId = folder?.localRootId ?? null;
  if (!rootId) return null;
  // 仅当该根确在本机才走 sidecar（缺失则交回云端，由模式栏走重连/切云降级）。
  const roots = await window.fsApi.listRoots();
  if (!roots.some((r) => r.id === rootId)) return null;
  return { rootId, subpath: folder?.localSubpath ?? "" };
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
