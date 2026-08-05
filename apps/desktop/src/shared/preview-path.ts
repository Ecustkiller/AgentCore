/**
 * 预览 / workspace 协议共用的相对路径守卫（纯逻辑，无 electron）。
 *
 * 主进程 `preview://` 与 `workspace://`、渲染层「系统浏览器打开」共用同一 fail-closed 规则，
 * 禁止各入口私有复制。
 */

import {
  DEFAULT_WORKSPACE_ROOT_LABEL,
  stripRootLabelPrefix,
} from "./workspace-path";

/**
 * 把协议 pathname 归一化为「会话工作区内相对 POSIX 路径」，越界即返回 null。
 *
 * 标准 scheme 下 Chromium 已折叠 `../`，但这是纵深守卫（路径穿越防护）：先整体 decode
 * （挡 `%2e%2e` 之类编码穿越），再拒 `..` 段 / null 字节 / 盘符（Windows 绝对路径）。
 * 返回**已 decode** 的相对路径。
 *
 * 另：模型工具常带沙箱绝对路径 ``/workspace/…``（写盘已 strip），此处先
 * {@link stripRootLabelPrefix} 再去前导 ``/``，避免把根标签当成子目录（``workspace/…`` → 404）。
 */
export function normalizePreviewPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const posix = decoded.replace(/\\/g, "/");
  // 必须在剥前导 `/` 之前 strip：否则 `/workspace/x` → `workspace/x`，相对形不再救援。
  const stripped = stripRootLabelPrefix(posix, DEFAULT_WORKSPACE_ROOT_LABEL);
  if (stripped === ".") return null; // 裸 `/workspace` 不是文件
  const cleaned = stripped.replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const parts = cleaned.split("/").filter((s) => s && s !== ".");
  if (parts.length === 0) return null;
  if (parts.some((s) => s === "..")) return null;
  // Windows 盘符 / UNC 兜底（正常 preview:// path 不会出现，纵深）。
  if (/^[a-zA-Z]:$/.test(parts[0]) || /^[a-zA-Z]:/.test(parts[0])) return null;
  return parts.join("/");
}
