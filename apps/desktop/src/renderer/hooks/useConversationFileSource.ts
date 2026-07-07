import { useConversations } from "@/hooks/useConversations";
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
 * The {@link FileSource} for a conversation's side-panel file browser — the
 * single resolver shared by {@link WorkspaceMode}. When the workspace list has
 * no `conv:<id>` row (common right after a sidecar write, before explicit bind),
 * falls back to the same `localContainerRootId` resolution sidecar uses instead
 * of the cloud REST alias (which 404s on not-yet-promoted local scratch).
 */
export function useConversationFileSource(
  conversationId: string | null,
): FileSource | null {
  const ws = useConversationWorkspace(conversationId);
  const fsAvailable = hasLocalFiles();
  const conversations = useConversations();
  const localContainerRootId =
    conversations.find((c) => c.id === conversationId)?.localContainerRootId ??
    null;

  const [localFallback, setLocalFallback] = useState<LocalFallback>("idle");

  useEffect(() => {
    if (ws || !conversationId) {
      setLocalFallback("idle");
      return;
    }
    if (!fsAvailable || !localContainerRootId) {
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
  }, [ws, conversationId, fsAvailable, localContainerRootId]);

  return useMemo(() => {
    if (ws) return resolveWorkspaceSource(ws, fsAvailable);
    if (!conversationId) return null;

    const awaitingLocal =
      fsAvailable &&
      !!localContainerRootId &&
      (localFallback === "pending" || localFallback === "idle");
    if (awaitingLocal) return null;

    if (localFallback && typeof localFallback !== "string") {
      return localFallback;
    }
    return createWorkspaceSource(conversationId);
  }, [ws, conversationId, fsAvailable, localContainerRootId, localFallback]);
}
