import { hasNativeNotification } from "@/lib/capabilities";
import type { ShellPresenceSnapshot } from "@shared/notification-contract";

let snapshot: ShellPresenceSnapshot | null = null;

/** 网页 / 尚未拿到主进程快照时：用页面可见性近似壳在场。 */
export function readDomShellPresent(): boolean {
  if (typeof document === "undefined") return true;
  return !document.hidden && document.hasFocus();
}

export function applyShellPresenceSnapshot(
  next: ShellPresenceSnapshot | null,
): void {
  snapshot = next;
}

export function isShellPresent(): boolean {
  if (hasNativeNotification() && snapshot) return snapshot.present;
  return readDomShellPresent();
}

/** 真窗所跟对话。网页应用内浮层不走这条，由调用方补 store。 */
export function openFloatConversationIds(): string[] {
  return snapshot?.floatConversationIds ?? [];
}

/**
 * 订阅主进程壳在场。无 notificationApi（web / 单测）则 no-op，isShellPresent 走 DOM。
 */
export function startShellPresence(): () => void {
  const api =
    typeof window !== "undefined" ? window.notificationApi : undefined;
  if (
    !hasNativeNotification() ||
    !api?.getPresence ||
    !api?.onPresenceChanged
  ) {
    snapshot = null;
    return () => {};
  }
  void api.getPresence().then((s) => {
    snapshot = s;
  });
  return api.onPresenceChanged((s) => {
    snapshot = s;
  });
}

export async function showNativeNotification(
  title: string,
  body: string,
  opts?: { conversationId?: string },
): Promise<void> {
  if (!hasNativeNotification()) return;
  const api = window.notificationApi;
  if (!api?.show) return;
  try {
    const result = await api.show({
      title,
      body,
      conversationId: opts?.conversationId,
    });
    if (!result.ok) {
      console.warn("[nativeNotification]", result.reason);
    }
  } catch (e) {
    console.warn("[nativeNotification] show failed", e);
  }
}
