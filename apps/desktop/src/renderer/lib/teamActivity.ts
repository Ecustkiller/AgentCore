/**
 * 全局协作感知 (前端UX设计.md §一) 的纯逻辑：把「对话生成态 + 审批态」派生成一份活跃对话
 * 清单（侧栏活动横幅用），并判定一次收场是「完成」还是「失败」（跨对话通知用）。无 store /
 * React 依赖，便于单测；订阅接线见 services/teamActivityNotifications.ts（跨对话 toast）与
 * components/sidebar/ActivityBanner.tsx（侧栏横幅）。
 */

export type ActivityStatus = "running" | "awaiting";

/** A conversation with live team activity — one row in the sidebar activity banner. */
export interface ActiveConversation {
  id: string;
  title: string;
  status: ActivityStatus;
}

/**
 * 活跃对话清单：待审批优先于执行中（同一对话既在生成又在等审批时，只以「待审批」出现一次，
 * 因为那才是用户该先处理的信号）。`titleOf` 缺标题（对话不在缓存 / 已删）时回退「对话」。
 */
export function deriveActiveConversations(
  generatingIds: string[],
  awaitingIds: string[],
  titleOf: (id: string) => string | undefined,
): ActiveConversation[] {
  const awaiting = new Set(awaitingIds);
  const out: ActiveConversation[] = [];
  for (const id of awaitingIds) {
    out.push({ id, title: titleOf(id) ?? "对话", status: "awaiting" });
  }
  for (const id of generatingIds) {
    if (awaiting.has(id)) continue; // dedup: awaiting takes priority
    out.push({ id, title: titleOf(id) ?? "对话", status: "running" });
  }
  return out;
}

/** 活动横幅摘要文案：「N 个任务执行中 · M 个待审批」；无活动返回 null（横幅不渲染）。 */
export function summarizeActivity(active: ActiveConversation[]): string | null {
  if (active.length === 0) return null;
  let running = 0;
  let awaiting = 0;
  for (const a of active) {
    if (a.status === "awaiting") awaiting++;
    else running++;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} 个任务执行中`);
  if (awaiting > 0) parts.push(`${awaiting} 个待审批`);
  return parts.join(" · ");
}

interface TurnEndSnapshot {
  error: string | null;
  messages: { role: string; error?: unknown }[];
}

/**
 * 这条对话的最近一轮是否失败。两条失败链路盖在不同字段：SSE `error` 事件在回合收口【前】给
 * 最后一条助手消息盖 `error`；传输中断 (transport drop) 则在 finalize【后】写会话级 `error`
 * 字串。任一非空即失败——跨对话通知据此把「已完成」与「执行失败」分开。
 */
export function runtimeHasError(rt: TurnEndSnapshot): boolean {
  if (rt.error != null) return true;
  for (let i = rt.messages.length - 1; i >= 0; i--) {
    const m = rt.messages[i];
    if (m.role === "assistant") return m.error != null;
  }
  return false;
}

/** 当前正在查看的对话 id（解析 hash 路由 `#/conversations/:id`），其它路由返回 null——让
 * 通知器无需 React / router 依赖即可对「正在看的那条对话」保持沉默。 */
export function conversationIdFromHash(hash: string): string | null {
  const path = hash.replace(/^#/, "");
  const m = /^\/conversations\/([^/?#]+)/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 开发 / 回放态路由（#/preview、#/simulation）跑的是合成回合，不弹跨对话通知，让离线预览
 * 自检（frontend-preview）保持安静。 */
export function isTransientRoute(hash: string): boolean {
  const path = hash.replace(/^#/, "");
  return path.startsWith("/preview") || path.startsWith("/simulation");
}
