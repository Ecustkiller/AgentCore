/**
 * 桌面默认本地**容器根**（双模式工作区 决策 #11 / 工作区对称化 D1a）。
 *
 * 桌面裸聊不预塞共享默认 Folder；本地意向在**建会话时**定型并落库
 * （`Conversation.local_container_root_id`），首次产文件时由服务端在该容器根下懒建一个
 * per 对话本地文件夹（落 `~/Documents/AgentCore/<标题>/`，D1a 的 `root_id + subpath`），
 * 与云端裸聊懒建同构。把意向落到会话上（而非逐回合携带）使**所有提升路径**（回合 / 面板）
 * 一致读取——裸聊产文件时无论是 Agent 回合还是侧栏面板先写，都落到同一个地方。
 *
 * 本模块只负责一件事：解析/授权那个**容器根**（主进程 `fsApi.ensureDefaultRoot` 建 +
 * 授权 `~/Documents/AgentCore`），缓存其 root id——建会话时取它作为 `local_container_root_id`
 * （见 MessageInput 首发建会话处）。不建任何 Folder（懒建是服务端 DB 操作）。
 *
 * web / 手机无 `window.fsApi`，整模块 no-op（恒 null）→ 会话以云端意向创建（决策 #10 不变）。
 * 「云端临时对话」逃生口不在此：建会话处直接以 `local_container_root_id=null` 创建即可。
 */

// 本次会话内已解析出的默认容器根 id（解析一次后缓存复用）。
let cachedRootId: string | null = null;
// 进行中的解析（防 StrictMode 双触发 / 并发点击重复授权）。
let inflight: Promise<string | null> | null = null;

/** 桌面 FS 桥是否可用（web / 手机：否 → 整条本地优先逻辑 no-op）。 */
function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.fsApi;
}

/**
 * 确保桌面默认本地容器根（`~/Documents/AgentCore`）存在并授权，返回其 root id
 * （非桌面 / 失败 → null）。
 *
 * 幂等且并发安全：解析一次后缓存。**不创建任何 Folder**——一条桌面裸聊产文件时由服务端
 * 在此容器根下懒建 per 对话本地文件夹（D1a）。失败只记录、返回 null（该会话以云端意向创建，
 * 不阻断发送）。建会话时 await 它取 `local_container_root_id`；登录后 / 新建草稿时预热（见
 * AuthGate / newConversation）以摊薄首发时的授权等待。
 */
export async function ensureDefaultContainerRoot(): Promise<string | null> {
  if (!isDesktop()) return null;
  if (cachedRootId) return cachedRootId;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const root = await window.fsApi.ensureDefaultRoot();
      cachedRootId = root.id;
      return root.id;
    } catch (e) {
      console.error("[workspace] 默认本地容器根初始化失败", e);
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
