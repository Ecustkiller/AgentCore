/**
 * 文件树剪贴板——**一份，全局**。
 *
 * 每棵 {@link FileTree} 各持一份 state 时，剪切/复制只能粘回同一棵树；而文件中枢把每个
 * 云文件夹渲染成独立的树，「在 A 里剪切、到 B 里粘贴」是最基本的诉求。剪贴板因此跟着
 * 用户走而不是跟着树走，条目额外记住 `sourceId`，粘贴方才知道要不要走跨源搬运
 * （见 {@link resolveBridgedTransfer}）。
 */

import { useSyncExternalStore } from "react";
import type { ClipboardEntry } from "./fileTreeTypes";

let entry: ClipboardEntry | null = null;
const listeners = new Set<() => void>();

export function getFileClipboard(): ClipboardEntry | null {
  return entry;
}

export function setFileClipboard(next: ClipboardEntry | null): void {
  entry = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 订阅式读取（快照是稳定引用，故可直接喂 `useSyncExternalStore`）。 */
export function useFileClipboard(): ClipboardEntry | null {
  return useSyncExternalStore(subscribe, getFileClipboard, getFileClipboard);
}

/** 测试用：清空全局剪贴板（保留订阅者，别把已挂载的树断开）。 */
export function __resetFileClipboardForTests(): void {
  setFileClipboard(null);
}
