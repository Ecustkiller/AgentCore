import { useConversations } from "@/hooks/useConversations";
import { useFolders } from "@/hooks/useFolders";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { hasInAppPreview, hasLocalFiles } from "@/lib/capabilities";
import type { FileSource } from "@/lib/fileSource";
import { useReadOnlyOffline } from "@/lib/offlineMode";
import { openWorkspaceHtmlInBrowser } from "@/lib/openWorkspaceHtmlInBrowser";
import { asReadOnlyFileSource } from "@/services/sources/readOnlyFileSource";
import {
  createWorkspaceSource,
  resolveConversationLocalFileSource,
  resolveWorkspaceSource,
} from "@/services/sources/workspaceSource";
import { openWorkspaceInBrowser } from "@/services/workspace";
import { useEffect, useMemo, useState } from "react";

type LocalFallback = "idle" | "pending" | FileSource | null;

/**
 * 给云端会话工作区源挂上 HTML「完整预览」（右坞 BrowserPanel + workspace://）。
 *
 * 「在浏览器打开」文件中枢云源已自挂（`conv:` 走会话快照，`folder:` 走 ws 快照）；
 * 应用内完整预览跟**当前源落地 desk**（`folder:` / `conv:`）：对话侧栏按
 * `useConversationWorkspace` / hub 同源 wsId 补挂 `openInAppPreview`（并覆盖同会话
 * 的 `openInBrowser`，与会话快照路径对齐）。本地源（`local:` 前缀）不匹配 `workspace:`
 * → 不覆盖；web / 无对应能力环境按能力位逐个门控 → 入口不暴露。
 */
function withCloudPreviewEntries(
  source: FileSource | null,
  conversationId: string | null,
  workspaceId?: string | null,
): FileSource | null {
  if (!source || !conversationId) return source;
  if (!source.id.startsWith("workspace:")) return source;

  const withEntries: FileSource = { ...source };
  const landingWsId = workspaceId ?? `conv:${conversationId}`;
  // 完整预览：右坞浏览器壳 + workspace://（跟落地 desk）。
  if (hasInAppPreview()) {
    withEntries.openInAppPreview = (path: string) =>
      openWorkspaceHtmlInBrowser(conversationId, path, landingWsId);
  }
  // 在系统浏览器打开 —— 会话工作区快照 → 解压临时目录 → 系统默认浏览器（依赖 previewArchive）。
  if (window.fsApi?.previewArchive) {
    withEntries.openInBrowser = (path: string) =>
      openWorkspaceInBrowser(conversationId, path);
  }
  return withEntries;
}

/**
 * FileSource for a conversation's side-panel file browser.
 * Project local chats inherit folder root+subpath; bare local use container.
 */
export function useConversationFileSource(
  conversationId: string | null,
): FileSource | null {
  const offline = useReadOnlyOffline();
  const ws = useConversationWorkspace(conversationId);
  const fsAvailable = hasLocalFiles();
  const conversations = useConversations();
  const folders = useFolders();
  const conv = conversations.find((c) => c.id === conversationId) ?? null;
  const folder = conv?.folderId
    ? (folders.find((f) => f.id === conv.folderId) ?? null)
    : null;
  const localContainerRootId = conv?.localContainerRootId ?? null;
  const needsLocalFallback =
    (folder?.mode === "local" && !!folder.localRootId) ||
    !!localContainerRootId;

  const [localFallback, setLocalFallback] = useState<LocalFallback>("idle");

  useEffect(() => {
    if (ws || !conversationId) {
      setLocalFallback("idle");
      return;
    }
    if (!fsAvailable || !needsLocalFallback) {
      setLocalFallback(null);
      return;
    }

    let cancelled = false;
    setLocalFallback("pending");
    void resolveConversationLocalFileSource(conversationId).then((source) => {
      if (!cancelled) setLocalFallback(source);
    });
    return () => {
      cancelled = true;
    };
  }, [ws, conversationId, fsAvailable, needsLocalFallback]);

  return useMemo(() => {
    const base = ((): FileSource | null => {
      if (ws) {
        // N4-A: cloud workspaces unavailable offline (hub greys them; side panel too).
        if (offline && ws.location === "cloud") return null;
        const src = resolveWorkspaceSource(ws, fsAvailable);
        if (offline && src && ws.location === "local") {
          return asReadOnlyFileSource(src);
        }
        return src;
      }
      if (!conversationId) return null;

      const awaitingLocal =
        fsAvailable &&
        needsLocalFallback &&
        (localFallback === "pending" || localFallback === "idle");
      if (awaitingLocal) return null;

      if (localFallback && typeof localFallback !== "string") {
        return offline ? asReadOnlyFileSource(localFallback) : localFallback;
      }
      if (offline) return null;
      if (folder && folder.mode === "cloud") {
        return resolveWorkspaceSource(
          {
            wsId: `folder:${folder.id}`,
            name: folder.name,
            location: "cloud",
            rootId: null,
            subpath: "",
            hasFiles: true,
          },
          fsAvailable,
        );
      }
      return createWorkspaceSource(conversationId);
    })();

    const landingWsId =
      ws?.wsId ??
      (folder && folder.mode === "cloud"
        ? `folder:${folder.id}`
        : conversationId
          ? `conv:${conversationId}`
          : null);

    // 对话侧栏专属：给云端源挂「完整预览」+「在浏览器打开」出口（预览跟当前源 desk）。
    return withCloudPreviewEntries(base, conversationId, landingWsId);
  }, [
    ws,
    conversationId,
    fsAvailable,
    needsLocalFallback,
    localFallback,
    folder,
    offline,
  ]);
}
