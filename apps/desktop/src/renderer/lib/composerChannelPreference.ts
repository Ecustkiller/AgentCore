/**
 * Composer「在哪工作」通道记忆（§七 · 双通道观察期）。
 *
 * `cloud` = 云协作（推荐默认）；`local_traditional` = 本机传统（打开本地文件夹）。
 * 仅桌面 UI 持久化（uiStorage）；新用户 / 无记忆 → 云；本机用户不被每次推回云。
 */

import { uiGet, uiSet } from "@/lib/uiStorage";

const STORAGE_KEY = "composer-channel";

export type ComposerChannel = "cloud" | "local_traditional";

function parseChannel(raw: unknown): ComposerChannel | null {
  if (raw === "cloud" || raw === "local_traditional") return raw;
  return null;
}

/** 读上次通道；无记忆或非法值 → `cloud`。 */
export function getComposerChannelPreference(): ComposerChannel {
  return parseChannel(uiGet<unknown>(STORAGE_KEY)) ?? "cloud";
}

/** 记上次通道（cloud | local_traditional）。 */
export function setComposerChannelPreference(channel: ComposerChannel): void {
  uiSet(STORAGE_KEY, channel);
}
