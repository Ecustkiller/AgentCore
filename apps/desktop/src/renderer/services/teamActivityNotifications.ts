import { getConversations } from "@/hooks/useConversations";
import { showNativeNotification } from "@/lib/nativeNotification";
import {
  conversationIdFromHash,
  isTransientRoute,
  runtimeHasError,
} from "@/lib/teamActivity";
import { notifyInfo } from "@/lib/toast";
import { DRAFT_KEY, useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";

/**
 * 跨对话完成通知 (前端UX设计.md §一 全局协作感知)：只读订阅对话生成态 + 审批态，当用户**不在**某对话
 * 页面时，该对话的关键事件（回合完成 / 失败 / 需要审批）弹一条带「跳转」action 的 notifyInfo。
 * 纯前端感知层——不碰 SSE 契约 / 协议 fold，不新增事件；接线一次于 AppShell（与 realtime /
 * updates 同处），随会话常驻。
 */

/** 从会话缓存解析标题（非 React 调用）——缺（未加载 / 已删）时返回 null，调用方据此静默。 */
function titleOf(id: string): string | null {
  return getConversations().find((c) => c.id === id)?.title ?? null;
}

/** 跳转到某对话：先同步切当前会话（即时反馈），再驱动 hash 路由（等同点 <Link>）。 */
function jumpTo(conversationId: string): void {
  useConversationStore.getState().switchConversation(conversationId);
  window.location.hash = `/conversations/${conversationId}`;
}

/** 该对话不是当前正看的、也不在开发回放态 → 值得弹通知。 */
function shouldNotify(conversationId: string): boolean {
  const hash = window.location.hash;
  if (isTransientRoute(hash)) return false;
  return conversationIdFromHash(hash) !== conversationId;
}

function notifyTurnEnd(conversationId: string, failed: boolean): void {
  if (!shouldNotify(conversationId)) return;
  const title = titleOf(conversationId);
  if (!title) return;
  const message = failed ? `「${title}」执行失败` : `「${title}」已完成`;
  notifyInfo(message, {
    action: { label: "查看", onClick: () => jumpTo(conversationId) },
  });
  void showNativeNotification("AgentCore", message, { conversationId });
}

function notifyApproval(conversationId: string): void {
  if (!shouldNotify(conversationId)) return;
  const title = titleOf(conversationId);
  if (!title) return;
  const message = `「${title}」需要审批`;
  notifyInfo(message, {
    action: { label: "去处理", onClick: () => jumpTo(conversationId) },
  });
  void showNativeNotification("AgentCore", message, { conversationId });
}

function pendingApprovalIds(): string[] {
  const out: string[] = [];
  for (const e of useInteractionStore.getState().byId.values()) {
    if (
      e.kind === "approval" &&
      (e.status === "pending" || e.status === "submitting")
    ) {
      out.push(e.id);
    }
  }
  return out;
}

/**
 * Start the ambient cross-conversation notifier. Returns an unsubscribe fn (AppShell
 * calls it on unmount). Idempotent per call — each invocation owns its own subscriptions.
 */
export function startTeamActivityNotifications(): () => void {
  // Seed with approvals already pending at startup so a reconnect replay doesn't
  // re-toast prompts the user already knows about.
  const notifiedApprovals = new Set<string>(pendingApprovalIds());

  const unsubConversation = useConversationStore.subscribe((state, prev) => {
    for (const [id, prevRt] of Object.entries(prev.byId)) {
      if (id === DRAFT_KEY || !prevRt.isGenerating) continue;
      const nextRt = state.byId[id];
      if (nextRt?.isGenerating) continue; // still streaming — not a turn boundary
      const failedAtBoundary = nextRt
        ? runtimeHasError(nextRt)
        : runtimeHasError(prevRt);
      queueMicrotask(() => {
        const latest = useConversationStore.getState().byId[id];
        const failed = latest ? runtimeHasError(latest) : failedAtBoundary;
        notifyTurnEnd(id, failed);
      });
    }
  });

  const unsubApproval = useInteractionStore.subscribe((state) => {
    for (const e of state.byId.values()) {
      if (e.kind !== "approval") continue;
      if (e.status !== "pending" && e.status !== "submitting") continue;
      if (notifiedApprovals.has(e.id)) continue;
      notifiedApprovals.add(e.id);
      notifyApproval(e.conversationId);
    }
    // Prune settled ids so the dedup set tracks only live prompts (stays bounded).
    const live = new Set(pendingApprovalIds());
    for (const seen of notifiedApprovals) {
      if (!live.has(seen)) notifiedApprovals.delete(seen);
    }
  });

  return () => {
    unsubConversation();
    unsubApproval();
  };
}

/** OS 通知点击 → 跳转到对应对话（与 toast action 同路由）。 */
export function startNativeNotificationRouting(): () => void {
  const api =
    typeof window !== "undefined" ? window.notificationApi : undefined;
  if (!api?.onClicked) return () => {};
  return api.onClicked(({ conversationId }) => {
    if (conversationId) jumpTo(conversationId);
  });
}
