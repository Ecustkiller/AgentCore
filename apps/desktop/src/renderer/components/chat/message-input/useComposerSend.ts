import {
  patchConversationCache,
  upsertConversationFront,
} from "@/hooks/useConversations";
import { notifyError } from "@/lib/toast";
import { api } from "@/services/api";
import { provisionalConversationTitle } from "@/services/conversations";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import { loadLatestWindow } from "@/services/messages";
import { resolveDefaultPermissionPreset } from "@/services/permissionPreset";
import type { OutgoingAttachment } from "@/services/streamConversation";
import { sendTurn } from "@/services/turns";
import { getActiveRuntime, useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { PendingAttachment } from "./composerAttachments";
import { dispatchBackgroundTask } from "./dispatchBackgroundTask";
import { ensureAttachmentResident } from "./resideAttachment";

export function useComposerSend({
  value,
  setValue,
  attachments,
  setAttachments,
  isGenerating,
  backgroundMode,
  isLocal,
  closeMenu,
  onDispatch,
}: {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  isGenerating: boolean;
  backgroundMode: boolean;
  isLocal: boolean;
  closeMenu: () => void;
  /** Fires when a FOREGROUND turn is dispatched (not for 后台云端 handoffs) — the
   * canvas host uses it to start auto-following the new round. */
  onDispatch?: () => void;
}) {
  const addMessage = useConversationStore((s) => s.addMessage);
  const navigate = useNavigate();

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating) return;

    const activeConvId = useConversationStore.getState().currentConversationId;
    if (backgroundMode && isLocal && activeConvId) {
      dispatchBackgroundTask(activeConvId, trimmed);
      setValue("");
      closeMenu();
      return;
    }

    const pending = attachments;
    const store = useConversationStore.getState();
    const isFirstMessage = getActiveRuntime().messages.length === 0;

    let conversationId = store.currentConversationId;
    let createdNew = false;
    if (!conversationId) {
      const intent = useFoldersStore.getState().draftWorkspaceIntent;
      const targetFolderId = intent.kind === "project" ? intent.folderId : null;
      // Project chats inherit workspace — never write session-level local_*.
      // Quick cloud (default) → null container. Quick local → default container root.
      let localContainerRootId: string | null = null;
      if (intent.kind === "quick_local") {
        localContainerRootId = await ensureDefaultContainerRoot();
      }
      try {
        const permissionPreset = await resolveDefaultPermissionPreset();
        const conv = await api.post<{
          id: string;
          permission_preset?: string;
        }>("/v1/conversations", {
          title: null,
          folder_id: targetFolderId,
          local_container_root_id: localContainerRootId,
          permission_preset: permissionPreset,
        });
        conversationId = conv.id;
        upsertConversationFront({
          id: conv.id,
          title: provisionalConversationTitle(trimmed),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          lastMessagePreview: null,
          folderId: targetFolderId,
          localContainerRootId,
          permissionPreset:
            (conv.permission_preset as
              | "observe"
              | "workspace"
              | "full_trust"
              | undefined) ?? permissionPreset,
        });
        useConversationStore.getState().switchConversation(conv.id);
        createdNew = true;
        useFoldersStore.getState().resetDraftWorkspaceIntent();
      } catch (err) {
        notifyError(err, "新建对话失败");
        return;
      }
    }

    if (!isFirstMessage && getActiveRuntime().hasMoreAfter) {
      try {
        await loadLatestWindow(conversationId);
      } catch {
        /* best-effort */
      }
    }

    // 引用即驻留：在乐观气泡之前完成落盘/上传，失败则保留草稿附件。
    const outgoing: OutgoingAttachment[] = [];
    for (const a of pending) {
      if (a.kind === "file" && (a.stagingId || a.workspacePath || a.binary)) {
        const resided = await ensureAttachmentResident(conversationId, a);
        if (!resided.ok) {
          notifyError(new Error(resided.reason), "附件驻留失败");
          return;
        }
        outgoing.push({
          name: resided.name,
          path: resided.workspacePath || a.path,
          text: resided.binary ? "" : resided.text,
          truncated: resided.truncated,
          kind: "file",
          binary: resided.binary,
          workspace_path: resided.workspacePath || undefined,
        });
      } else {
        outgoing.push({
          name: a.name,
          path: a.path,
          text: a.text,
          truncated: a.truncated,
          kind: a.kind,
          conversation_id: a.conversationId,
          binary: a.binary,
          workspace_path: a.workspacePath,
        });
      }
    }

    const userMsgId = crypto.randomUUID();
    addMessage({
      id: userMsgId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
      attachments: pending.length
        ? pending.map((a, i) => ({
            id: a.id,
            name: outgoing[i]?.name ?? a.name,
            path: outgoing[i]?.path ?? a.path,
            truncated: a.truncated,
            kind: a.kind,
            conversationId: a.conversationId,
            workspacePath: outgoing[i]?.workspace_path,
          }))
        : undefined,
    });
    setValue("");
    setAttachments([]);
    closeMenu();

    if (isFirstMessage) {
      patchConversationCache(conversationId, {
        title: provisionalConversationTitle(trimmed),
      });
    }

    if (createdNew) {
      navigate(`/conversations/${conversationId}`);
    }

    // Same React batch as the optimistic bubble above, so a canvas follow effect
    // armed here sees the new turn land.
    onDispatch?.();

    await sendTurn({
      conversationId,
      content: trimmed,
      attachments: outgoing,
      optimisticUserId: userMsgId,
    });
  }, [
    value,
    attachments,
    isGenerating,
    addMessage,
    navigate,
    closeMenu,
    backgroundMode,
    isLocal,
    setValue,
    setAttachments,
    onDispatch,
  ]);

  return { handleSend };
}
