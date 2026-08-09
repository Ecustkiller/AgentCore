/**
 * `workspace://` URL 纯解析 —— desk host（`folder.|conv.`）+ 路径 fail-closed。
 *
 * URL：`workspace://{folder|conv}.{uuid}/{rel}`（host 用 `.` 替 ws_id 里的 `:`）。
 * 守卫：`conv.{uuid}` 且 uuid≠boundConversationId → 403；`folder.*` 在本
 * partition 内放行（鉴权靠服务端）。
 *
 * 主进程协议 handler 与渲染层「导出临时副本 → 系统浏览器」共用；
 * **绝不**把本 scheme 交给 `shell.openExternal` / 放宽 {@link isSafeExternalUrl}。
 */

import { normalizePreviewPath } from "./preview-path";

export const WORKSPACE_SCHEME = "workspace";

const WS_KIND_RE = /^(folder|conv)$/;

function normalizeConversationId(
  conversationId: string | null | undefined,
): string {
  if (typeof conversationId !== "string") return "";
  return conversationId.trim().toLowerCase();
}

/**
 * `folder:{id}` / `conv:{uuid}` → URL host `folder.{id}` / `conv.{uuid}`。
 * 非法 kind 或缺 id → null。
 */
export function workspaceIdToHost(workspaceId: string): string | null {
  if (typeof workspaceId !== "string") return null;
  const raw = workspaceId.trim().toLowerCase();
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) return null;
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (!WS_KIND_RE.test(kind) || !id || id.includes(":")) return null;
  return `${kind}.${id}`;
}

/**
 * URL host `folder.{id}` / `conv.{uuid}` → `folder:{id}` / `conv:{uuid}`。
 */
export function hostToWorkspaceId(host: string): string | null {
  if (typeof host !== "string") return null;
  const raw = host.trim().toLowerCase();
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const kind = raw.slice(0, dot);
  const id = raw.slice(dot + 1);
  if (!WS_KIND_RE.test(kind) || !id) return null;
  return `${kind}:${id}`;
}

/**
 * 纯校验：desk host → wsId；`conv.*` 须等于绑定 cid，`folder.*` 本 partition 放行。
 * 缺 host/path → 403；跨 conv → 403；非法 scheme / 畸形 URL → 400。
 */
export function resolveWorkspaceProtocolRequest(
  requestUrl: string,
  boundConversationId: string,
):
  | { ok: true; workspaceId: string; rel: string }
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
  const workspaceId = hostToWorkspaceId(url.hostname);
  const rel = normalizePreviewPath(url.pathname);
  if (!workspaceId || !rel) return { ok: false, status: 403 };

  if (workspaceId.startsWith("conv:")) {
    const uuid = workspaceId.slice("conv:".length);
    if (uuid !== bound) return { ok: false, status: 403 };
  }
  // folder:* — 本 partition 放行；鉴权靠服务端 /v1/workspaces/…

  return { ok: true, workspaceId, rel };
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
