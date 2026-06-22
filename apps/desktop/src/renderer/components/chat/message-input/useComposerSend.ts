import {
  patchConversationCache,
  upsertConversationFront,
} from "@/hooks/useConversations";
import { notifyError } from "@/lib/toast";
import { api } from "@/services/api";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import { loadLatestWindow } from "@/services/messages";
import type { OutgoingAttachment } from "@/services/streamConversation";
import { sendTurn } from "@/services/turns";
import { getActiveRuntime, useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { PendingAttachment } from "./composerAttachments";
import { dispatchBackgroundTask } from "./dispatchBackgroundTask";

export function useComposerSend({
  value,
  setValue,
  attachments,
  setAttachments,
  isGenerating,
  backgroundMode,
  isLocal,
  closeMenu,
}: {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  isGenerating: boolean;
  backgroundMode: boolean;
  isLocal: boolean;
  closeMenu: () => void;
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
      const foldersStore = useFoldersStore.getState();
      const targetFolderId = foldersStore.pendingNewChatFolderId;
      const cloudEscape = foldersStore.pendingNewChatCloud;
      const localContainerRootId =
        targetFolderId || cloudEscape
          ? null
          : await ensureDefaultContainerRoot();
      try {
        const conv = await api.post<{ id: string }>("/v1/conversations", {
          title: null,
          folder_id: targetFolderId,
          local_container_root_id: localContainerRootId,
        });
        conversationId = conv.id;
        upsertConversationFront({
          id: conv.id,
          title: "新对话",
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          lastMessagePreview: null,
          folderId: targetFolderId,
          localContainerRootId,
        });
        useConversationStore.getState().switchConversation(conv.id);
        createdNew = true;
        useFoldersStore.getState().setPendingNewChatFolder(null);
        useFoldersStore.getState().setPendingNewChatCloud(false);
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

    const userMsgId = crypto.randomUUID();
    addMessage({
      id: userMsgId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
      attachments: pending.length
        ? pending.map((a) => ({
            id: a.id,
            name: a.name,
            path: a.path,
            truncated: a.truncated,
            kind: a.kind,
            conversationId: a.conversationId,
          }))
        : undefined,
    });
    setValue("");
    setAttachments([]);
    closeMenu();

    if (isFirstMessage) {
      const title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
      patchConversationCache(conversationId, { title });
    }

    if (createdNew) {
      navigate(`/conversations/${conversationId}`);
    }

    const outgoing: OutgoingAttachment[] = pending.map((a) => ({
      name: a.name,
      path: a.path,
      text: a.text,
      truncated: a.truncated,
      kind: a.kind,
      conversation_id: a.conversationId,
    }));

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
  ]);

  return { handleSend };
}
