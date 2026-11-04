/**
 * opt-in 实验开关（最后修订 2026-11-04）。
 *
 * 上游 `98ea13bf`（2026-09-20）明确卸掉了「人侧文档/表格编辑器」——commit
 * message 是「人侧不再进文档/表格编辑器」。那些页面、services 和测试仍留在
 * 树里，只是 router 不再引用，成了「测试绿但用户不可达」的死代码。
 *
 * 本仓的移植原则是**不逆向复活上游已做校准删掉的方向**，所以这里不把它们
 * 无条件挂回去，也不删代码：默认状态与上游完全一致，`/docs`、`/tables` 依旧
 * 收向 `/files`、侧栏无入口。只有当用户主动打开开关，才放行这些路由。
 *
 * 用 uiStorage 而不是直接碰 localStorage（`check-no-localstorage.mjs` 门禁）。
 * `useSyncExternalStore` 让侧栏和路由守卫在切换后立刻响应，无需刷新页面。
 */

import { uiGet, uiSet } from "@/lib/uiStorage";
import { useSyncExternalStore } from "react";

/** 人侧文档 / 表格编辑器。默认 false = 跟随上游。 */
export const LABS_HUMAN_DOCS_TABLES = "labs.humanDocsTables" as const;

export type LabsFlagKey = typeof LABS_HUMAN_DOCS_TABLES;

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function emitChange(): void {
  for (const callback of listeners) callback();
}

/** 同步读取。非 React 调用点（命令面板、路由前缀判断）用这个。 */
export function readLabsFlag(key: LabsFlagKey): boolean {
  return uiGet<boolean>(key) === true;
}

export function setLabsFlag(key: LabsFlagKey, enabled: boolean): void {
  uiSet(key, enabled);
  emitChange();
}

/** 供组件订阅；快照是 boolean，不会因每次读产生新对象而无限重渲染。 */
export function useLabsFlag(key: LabsFlagKey): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readLabsFlag(key),
    () => false, // 服务端/离线回放一律按默认关处理
  );
}

/** 人侧文档 / 表格编辑器的便捷读法。 */
export function useHumanDocsTablesEnabled(): boolean {
  return useLabsFlag(LABS_HUMAN_DOCS_TABLES);
}
