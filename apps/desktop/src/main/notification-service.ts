/**
 * 桌面 OS 原生通知 —— 壳不在场时协作感知的系统栏出口。
 *
 * Renderer 无法伪造：通知由主进程 `Notification` 弹出；点击还原主窗并带回
 * `conversationId` 供主窗 renderer 跳转（真窗没有这条跳转接线）。
 *
 * 同一对话一条槽位：Windows Toast `tag` 最长 16 字，对话 id 先哈希再写入；
 * 同时按槽位 `close()` 上一条，macOS / Linux 没有 tag 时也替换而不是叠。
 */
import { createHash } from "node:crypto";
import {
  NOTIFICATION_CHANNELS,
  type NotificationShowInput,
  type NotificationShowResult,
} from "@shared/notification-contract";
import { type BrowserWindow, Notification, ipcMain } from "electron";

let getMainWindow: () => BrowserWindow | null = () => null;

/** Windows `ToastNotification.Tag` 上限 16；hex 切片保证可替换且字符集安全。 */
export function osNotificationTag(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 16);
}

const liveBySlot = new Map<string, Notification>();

export function configureNotificationService(deps: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  getMainWindow = deps.getMainWindow;
}

function focusMainWindow(): BrowserWindow | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

function parseInput(raw: unknown): NotificationShowInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (!title) return null;
  const conversationId =
    typeof o.conversationId === "string" && o.conversationId.trim()
      ? o.conversationId.trim()
      : undefined;
  return { title, body, conversationId };
}

function slotKey(input: NotificationShowInput): string {
  return input.conversationId
    ? `conv:${input.conversationId}`
    : `title:${input.title}`;
}

/** 在用户 shell 通知中心弹出一条原生通知。 */
export function showOsNotification(
  input: NotificationShowInput,
): NotificationShowResult {
  if (!Notification.isSupported()) {
    return { ok: false, reason: "系统不支持原生通知" };
  }
  const tag = input.conversationId
    ? osNotificationTag(input.conversationId)
    : undefined;
  const slot = slotKey(input);
  // 不传 icon：Win11 顶栏 attribution 已有 AUMID 图标，再传会变成正文
  // appLogoOverride，和产品名叠成重复身份。macOS 用 bundle 图标。
  const notification = new Notification({
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(tag ? { tag } : {}),
  });
  notification.on("click", () => {
    const win = focusMainWindow();
    if (win && input.conversationId) {
      win.webContents.send(NOTIFICATION_CHANNELS.clicked, {
        conversationId: input.conversationId,
      });
    }
  });
  notification.on("close", () => {
    if (liveBySlot.get(slot) === notification) liveBySlot.delete(slot);
  });
  const prev = liveBySlot.get(slot);
  liveBySlot.set(slot, notification);
  prev?.close();
  notification.show();
  return { ok: true };
}

export function registerNotificationIpc(): void {
  ipcMain.handle(
    NOTIFICATION_CHANNELS.show,
    (_event, raw: unknown): NotificationShowResult => {
      const input = parseInput(raw);
      if (!input) return { ok: false, reason: "无效通知参数" };
      return showOsNotification(input);
    },
  );
}
