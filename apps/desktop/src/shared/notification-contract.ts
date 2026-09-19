/**
 * 桌面 OS 原生通知 IPC 契约 —— 主进程 / preload / renderer 三端共享。
 *
 * 壳不在场时协作感知走系统通知栏（与应用内提示互斥）。浏览器预览不注入。
 */

import type { ShellPresenceSnapshot } from "./shell-presence";

export type { ShellPresenceSnapshot } from "./shell-presence";

export const NOTIFICATION_CHANNELS = {
  show: "notification:show",
  clicked: "notification:clicked",
  presenceGet: "notification:presence-get",
  presenceChanged: "notification:presence-changed",
} as const;

export interface NotificationShowInput {
  title: string;
  body: string;
  /** 点击通知时带回 renderer，用于跳转到对应对话。 */
  conversationId?: string;
}

export type NotificationShowResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface NotificationApi {
  show: (input: NotificationShowInput) => Promise<NotificationShowResult>;
  onClicked: (cb: (payload: { conversationId?: string }) => void) => () => void;
  getPresence: () => Promise<ShellPresenceSnapshot>;
  onPresenceChanged: (
    cb: (snapshot: ShellPresenceSnapshot) => void,
  ) => () => void;
}
