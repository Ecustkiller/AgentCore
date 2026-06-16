import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import type { NavigateFunction } from "react-router-dom";

/**
 * 开启一个全新的草稿对话并跳到 `/`。草稿只活在 store 里（不落库），首条消息发送时
 * 才由 MessageInput 真正在后端创建会话；`folderId` 预设这条会话首发时归入的文件夹
 * （null = 未分组）。
 *
 * 这是「新建对话」意图的唯一实现，被侧栏「对话」入口 /「+」、Ctrl/Cmd+N 快捷键、
 * 「全部对话」页共用——让每个入口完全一致，避免「对话」导航再次退化成"显示上次
 * 那条会话"。路由 `/` 本身是真相来源（{@link ConversationPage} 在无 `:id` 时丢弃
 * 已打开的会话），这里同步重置 store 只是为了避免页面 effect 跑之前闪一帧旧对话。
 */
export function startNewConversation(
  navigate: NavigateFunction,
  folderId: string | null = null,
): void {
  useFoldersStore.getState().setPendingNewChatFolder(folderId);
  useConversationStore.getState().switchConversation(null);
  navigate("/");
}
