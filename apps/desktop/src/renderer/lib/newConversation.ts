import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import type { NavigateFunction } from "react-router-dom";

/**
 * 开启一个全新的草稿对话并跳到 `/`。草稿只活在 store 里（不落库），首条消息发送时
 * 才由 MessageInput 真正在后端创建会话；`folderId` 预设这条会话首发时归入的文件夹
 * （显式传入则尊重）。不传 / null = 桌面**裸聊**：不预塞文件夹，首次产文件时由服务端在默认
 * 本地容器下懒建一个 per 对话本地文件夹（工作区对称化 D1a，决策 #11 local-first）。
 * 传 `opts.cloud` 走「云端临时对话」逃生口——裸聊懒建落云端、不碰本地盘。
 *
 * 这是「新建对话」意图的唯一实现，被侧栏「对话」入口 /「+」、Ctrl/Cmd+N 快捷键、
 * 「全部对话」页共用——让每个入口完全一致，避免「对话」导航再次退化成"显示上次
 * 那条会话"。路由 `/` 本身是真相来源（{@link ConversationPage} 在无 `:id` 时丢弃
 * 已打开的会话），这里同步重置 store 只是为了避免页面 effect 跑之前闪一帧旧对话。
 */
export function startNewConversation(
  navigate: NavigateFunction,
  folderId?: string | null,
  opts?: { cloud?: boolean },
): void {
  // 桌面 local-first（决策 #11 / 工作区对称化 D1a）：裸聊不再预塞默认文件夹——只在这里**预热**
  // 默认本地容器根（授权 + 缓存其 id），摊薄首发时的授权等待。本地意向在**建会话时**定型并
  // 落库（MessageInput 首发处 await `ensureDefaultContainerRoot` 取 `local_container_root_id`），
  // 服务端首次产文件时据此在该容器下懒建 per 对话文件夹。显式传入的文件夹 id 一律尊重；
  // `opts.cloud` 走纯云逃生口（建会话即以 `local_container_root_id=null` 创建，不预热容器根）。
  const target = opts?.cloud ? null : (folderId ?? null);
  if (!opts?.cloud && folderId == null) void ensureDefaultContainerRoot();
  const foldersStore = useFoldersStore.getState();
  foldersStore.setPendingNewChatFolder(target);
  // 记下「这条草稿是否显式要云」，让首发处把它与「未指定（桌面默认本地懒建）」区分开。
  foldersStore.setPendingNewChatCloud(!!opts?.cloud);
  useConversationStore.getState().switchConversation(null);
  navigate("/");
}
