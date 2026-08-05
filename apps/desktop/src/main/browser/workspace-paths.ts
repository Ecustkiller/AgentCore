/**
 * 本机浏览器「工作区 HTML」协议的**纯逻辑**（L1b 第二非持久 partition）。
 *
 * 与外网页 {@link browserPartitionFor}、旧预览 {@link PREVIEW_PARTITION} **三分立**：
 * 不共用 session，防 cookie 串到产物页。路径守卫 / MIME / CSP 复用 preview/paths
 * （安全不变量不得削弱）；本文件只换 scheme + partition 名。
 *
 * 首期：workspace partition **亦按 conversationId 切开**（与外网同级）。
 */

import {
  WORKSPACE_SCHEME,
  resolveWorkspaceProtocolRequest,
} from "@shared/workspace-browser-url";
import {
  PREVIEW_CSP,
  mimeForPath,
  normalizePreviewPath,
  workspaceFilePath,
} from "../preview/paths";
import { normalizeBrowserConversationId } from "./paths";

export { resolveWorkspaceProtocolRequest, WORKSPACE_SCHEME };

/** 工作区 partition 前缀（完整键 = {@link workspacePartitionFor}）。 */
export const WORKSPACE_PARTITION_PREFIX = "agentcore-browser-workspace";

/**
 * 工作区 HTML 宿主所用的**非持久独立分区**（无 `persist:`）。
 * 键：`agentcore-browser-workspace:conv:{conversationId}`。
 * ≠ 外网 `agentcore-browser:conv:…`、≠ `agentcore-preview`。
 */
export function workspacePartitionFor(conversationId: string): string {
  const cid = normalizeBrowserConversationId(conversationId);
  if (!cid) {
    throw new Error("workspacePartitionFor: conversationId required");
  }
  return `${WORKSPACE_PARTITION_PREFIX}:conv:${cid}`;
}

/** 与预览相同的纵深 CSP（sandbox + 独立分区已是边界）。 */
export const WORKSPACE_CSP = PREVIEW_CSP;

export { mimeForPath, normalizePreviewPath, workspaceFilePath };

/**
 * 构造要在本机浏览器工作区页里加载的 `workspace://` URL。
 * 会话 id 作 host（小写 UUID）；路径经 {@link normalizePreviewPath} 守卫后逐段编码。
 */
export function buildWorkspaceUrl(
  conversationId: string,
  path: string,
): string {
  const host = normalizeBrowserConversationId(conversationId);
  const rel = normalizePreviewPath(path);
  const encoded = rel ? rel.split("/").map(encodeURIComponent).join("/") : "";
  return `${WORKSPACE_SCHEME}://${host}/${encoded}`;
}

/** 是否本机浏览器允许的工作区协议 URL。 */
export function isWorkspaceBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    return (
      new URL(url.trim()).protocol.toLowerCase() === `${WORKSPACE_SCHEME}:`
    );
  } catch {
    return false;
  }
}
