import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import type { NavigateFunction } from "react-router-dom";

/**
 * 开启一个全新的草稿对话并跳到 `/`。草稿只活在 store 里（不落库），首条消息发送时
 * 才由 MessageInput 真正在后端创建会话。
 *
 * - 不传 folderId：桌面 → 快速对话（本地 scratch）；web → 云端草稿
 * - 传 folderId：项目草稿（出生定终身继承项目工作区）
 * - `opts.cloud`：显式云端草稿（快速对话 · 云）
 */
export function startNewConversation(
  navigate: NavigateFunction,
  folderId?: string | null,
  opts?: { cloud?: boolean },
): void {
  const foldersStore = useFoldersStore.getState();
  if (opts?.cloud) {
    foldersStore.setDraftWorkspaceIntent({ kind: "quick_cloud" });
  } else if (folderId) {
    foldersStore.setDraftWorkspaceIntent({
      kind: "project",
      folderId,
    });
  } else {
    foldersStore.resetDraftWorkspaceIntent();
    void ensureDefaultContainerRoot();
  }
  useConversationStore.getState().switchConversation(null);
  navigate("/");
}
