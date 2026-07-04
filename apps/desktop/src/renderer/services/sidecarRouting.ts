import { getConversations } from "@/hooks/useConversations";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { hasLocalEngine } from "@/lib/capabilities";
import type { WorkspaceInfo } from "@/services/workspaces";
import { getRuntime } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import type { SidecarHistoryEntry } from "@shared/sidecar-contract";

/**
 * 会话路由判定：一个回合该走本地 sidecar，还是云端 SSE。
 *
 * 双模式工作区 / 远期规划 §一.1。sidecar 的持久化 / 计费现经回合结束**回写云端**已闭环（幂等
 * 可重试，见 `streamConversationViaSidecar` / `localTurns`），且**启动失败会自动降级回云端**
 * （见 `turns.sendTurn`），故本地引擎已毕业到**默认开**。
 *
 * 路由判定：会话绑定本机存在的本地根、本回合无附件、且开关有效（默认开，用户可在
 * `设置 → 模型配置` 关闭）时走 sidecar；无本地绑定 / 带附件 / 显式关闭 → 维持云链路。
 * 注意 sidecar 暂非真离线（LLM 仍经云推理代理）、被委派 worker 仍走审批门——这些是其限制，
 * 不再是 opt-in 的理由。
 */

/**
 * 一次 sidecar 回合的寻址目标：本地容器根 id + 工作区子路径（conversation scratch）。
 *
 * `subpath` 空 = 该根自身；非空 = 该容器根下 per-conversation scratch 子目录。主进程据
 * `rootId + subpath` 把 sidecar 进程绑定到 `容器根/子路径`。
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

/** sidecar 路由是否启用（桌面本地引擎可用 + 用户设置开关「本地引擎」；web 恒 false → 走云）。 */
export function isSidecarEnabled(): boolean {
  return hasLocalEngine() && useUIStore.getState().sidecarEnabled;
}

function scratchFromWorkspaceCache(
  conversationId: string,
): { rootId: string | null; subpath: string } | null {
  const workspaces = queryClient.getQueryData<WorkspaceInfo[]>(
    workspaceKeys.list,
  );
  const ws = workspaces?.find((w) => w.wsId === `conv:${conversationId}`);
  if (!ws) return null;
  return { rootId: ws.rootId, subpath: ws.subpath ?? "" };
}

/**
 * 解析一个会话「能用本地引擎」时的目标（容器根 id + scratch 子路径），**不看开关是否已开**——
 * 纯看会话有没有绑定一个本机确实存在的本地根。两处复用：① {@link resolveSidecarRoot} 在
 * 开关开时据此寻址；② {@link canConversationUseSidecar} 作为「该对话能否走本地引擎」的公共
 * 查询（与开关状态正交，供 UI 状态展示 / 启动探活等复用）。
 *
 * 从 conversation scratch 字段（经 workspace rail 缓存或 `localContainerRootId` 意向）解析，
 * 再核对该根**确在本机**（否则属 §八「路径不存在」降级，交回云链路处理）。
 */
async function resolveLocalTarget(
  conversationId: string,
): Promise<SidecarTarget | null> {
  const conv =
    getConversations().find((c) => c.id === conversationId) ?? null;
  if (!conv) return null;

  const cached = scratchFromWorkspaceCache(conversationId);
  const rootId =
    cached?.rootId ?? conv.localContainerRootId ?? null;
  const subpath = cached?.subpath ?? "";
  if (!rootId) return null;

  const roots = await window.fsApi.listRoots();
  if (!roots.some((r) => r.id === rootId)) return null;
  return { rootId, subpath };
}

/**
 * 解析一个会话应在其上跑 sidecar 的目标（容器根 id + scratch 子路径）；不该走 sidecar 则 null。
 *
 * = 用户开了「本地引擎」开关（{@link isSidecarEnabled}）**且**该会话能用本地引擎
 * （{@link resolveLocalTarget}）。开关关 / 无本地绑定 / 根不在本机 → null（交回云链路）。
 *
 * 纯「绑定判定」，**不掺运行时健康**：本判定被新回合（`sendTurn`）、续跑（`runResume`）、列暂停
 * 帧（`loadPausedTurns`）三处复用，而「环境能否拉起」（探活 / 降级标记，见 sidecarHealth）对三者
 * 语义不同——对新回合是「降级走云」的理由，对续跑 / 列帧反而是「本机帧只在本地、绝不能误走云」。
 * 故健康收敛留给各调用方按自身语义处理（`sendTurn` 探活失败走云、`runResume` 探活失败保留帧出
 * 横幅、`loadPausedTurns` 只读本机帧不关心进程健康），不在此处统一挡掉、以免污染后两者。
 */
export async function resolveSidecarRoot(
  conversationId: string,
): Promise<SidecarTarget | null> {
  if (!isSidecarEnabled()) return null;
  return resolveLocalTarget(conversationId);
}

/**
 * 该会话是否「能用本地引擎」（桌面端 + 绑定本机存在的本地根），**不看开关是否已开**——与
 * {@link isSidecarEnabled}（开关）正交的公共查询。供 UI 判断某对话是否值得围绕本地引擎做
 * 状态展示 / 提示（如启动探活），只有真能走 sidecar 的对话（local 模式 + 根在本机）才返回 true。
 */
export async function canConversationUseSidecar(
  conversationId: string,
): Promise<boolean> {
  if (!hasLocalEngine()) return false;
  return (await resolveLocalTarget(conversationId)) !== null;
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
