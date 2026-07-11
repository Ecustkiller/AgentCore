import { useConversations } from "@/hooks/useConversations";
import { useFolders } from "@/hooks/useFolders";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { hasLocalFiles } from "@/lib/capabilities";
import type { FileSource } from "@/lib/fileSource";
import {
  createWorkspaceSource,
  resolveConversationLocalFileSource,
  resolveWorkspaceSource,
} from "@/services/sources/workspaceSource";
import { useEffect, useMemo, useState } from "react";

type LocalFallback = "idle" | "pending" | FileSource | null;

/**
 * FileSource for a conversation's side-panel file browser.
 * Project local chats inherit folder root+subpath; bare local use container.
 */
export function useConversationFileSource(
  conversationId: string | null,
): FileSource | null {
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
    if (ws) return resolveWorkspaceSource(ws, fsAvailable);
    if (!conversationId) return null;

    const awaitingLocal =
      fsAvailable &&
      needsLocalFallback &&
      (localFallback === "pending" || localFallback === "idle");
    if (awaitingLocal) return null;

    if (localFallback && typeof localFallback !== "string") {
      return localFallback;
    }
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
  }, [
    ws,
    conversationId,
    fsAvailable,
    needsLocalFallback,
    localFallback,
    folder,
  ]);
}
