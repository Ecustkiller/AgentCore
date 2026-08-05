/**
 * `workspace://` URL 纯解析 —— 对话隔离（host === bound cid）+ 路径 fail-closed。
 *
 * 主进程协议 handler 与渲染层「导出临时副本 → 系统浏览器」共用；
 * **绝不**把本 scheme 交给 `shell.openExternal` / 放宽 {@link isSafeExternalUrl}。
 */

import { normalizePreviewPath } from "./preview-path";

export const WORKSPACE_SCHEME = "workspace";

function normalizeConversationId(
  conversationId: string | null | undefined,
): string {
  if (typeof conversationId !== "string") return "";
  return conversationId.trim().toLowerCase();
}

/**
 * 纯校验：请求 URL 的 host 是否等于绑定的 conversationId。
 * 缺 host/path → 403；跨 cid → 403；非法 scheme / 畸形 URL → 400。
 */
export function resolveWorkspaceProtocolRequest(
  requestUrl: string,
  boundConversationId: string,
):
  | { ok: true; conversationId: string; rel: string }
  | { ok: false; status: 400 | 403 } {
  const bound = normalizeConversationId(boundConversationId);
  if (!bound) return { ok: false, status: 403 };
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.protocol.toLowerCase() !== `${WORKSPACE_SCHEME}:`) {
    return { ok: false, status: 400 };
  }
  const host = normalizeConversationId(url.hostname);
  const rel = normalizePreviewPath(url.pathname);
  if (!host || !rel) return { ok: false, status: 403 };
  if (host !== bound) return { ok: false, status: 403 };
  return { ok: true, conversationId: host, rel };
}

/**
 * 渲染层外开入口：本会话可打开的工作区相对路径；否则 null（fail-closed）。
 */
export function resolveWorkspaceOpenRel(
  url: string,
  conversationId: string | null | undefined,
): string | null {
  if (!conversationId) return null;
  const resolved = resolveWorkspaceProtocolRequest(url, conversationId);
  return resolved.ok ? resolved.rel : null;
}
