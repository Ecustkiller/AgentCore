import { getConversations } from "@/hooks/useConversations";

/**
 * 桌面默认本地**容器根**（双模式工作区 决策 #11 / 工作区对称化 D1a）。
 *
 * 取代旧「我的工作区」预塞文件夹模型：桌面裸聊不再创建一个全用户共用的默认 Folder，而是
 * 回到真正的裸聊——**首次产文件时由服务端懒建一个 per 对话本地文件夹**（落容器
 * `~/Documents/AgentCore/<标题>/`，D1a 的 `root_id + subpath`），与云端裸聊懒建同构。
 *
 * 本模块只负责两件事：
 *  1. 解析/授权那个**容器根**（主进程 `fsApi.ensureDefaultRoot` 建 + 授权
 *     `~/Documents/AgentCore`），缓存其 root id——它就是回合携带的「待定本地容器根」信号。
 *     不再建任何 Folder（懒建是服务端 DB 操作）。
 *  2. 记录「云端临时对话」逃生口会话，使其裸聊懒建落**云端**（不携带容器根）。
 *
 * web / 手机无 `window.fsApi`，整模块 no-op（恒 null）→ 裸聊懒建走云端（决策 #10 不变）。
 */

// 本次会话内已解析出的默认容器根 id（解析一次后同步可读，供首发处即时判断）。
let cachedRootId: string | null = null;
// 进行中的解析（防 StrictMode 双触发 / 并发点击重复授权）。
let inflight: Promise<string | null> | null = null;

/** 桌面 FS 桥是否可用（web / 手机：否 → 整条本地优先逻辑 no-op）。 */
function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.fsApi;
}

/** 已解析则返回默认容器根 id（同步可读）；未解析 / 非桌面 → null。 */
export function getDefaultContainerRootId(): string | null {
  return cachedRootId;
}

/**
 * 确保桌面默认本地容器根（`~/Documents/AgentCore`）存在并授权，返回其 root id
 * （非桌面 / 失败 → null）。
 *
 * 幂等且并发安全：解析一次后缓存。**不再创建任何 Folder**——一条桌面裸聊产文件时由服务端
 * 在此容器根下懒建 per 对话本地文件夹（D1a），而非预塞一个共享的「我的工作区」。失败只记录、
 * 返回 null（该次裸聊懒建回落云端，不阻断发送）。
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

// 「云端临时对话」逃生口（决策 #11）：标记的会话其裸聊懒建落**云端**——首发不携带本地容器
// 根，故服务端走云端懒建（现行为）。仅本进程内有效：逃生口是一次性的「随手云问答」意图，
// 重开会话即按桌面默认（本地）。web / 手机本就恒走云（isDesktop()=false）。
const cloudEscapeConversations = new Set<string>();

/** 标记一条会话为「云端临时对话」——其裸聊懒建落云端（不携带本地容器根）。 */
export function markCloudEscapeConversation(conversationId: string): void {
  cloudEscapeConversations.add(conversationId);
}

/**
 * 该会话本回合应携带的「待定本地容器根」id（工作区对称化 D2），无则 null。
 *
 * 仅当 **桌面 + 该会话仍是裸聊（无文件夹）+ 非云端逃生口** 时返回容器根 id——服务端据此在
 * 首次产文件时把这条裸聊懒建为该容器下的一个 per 对话本地文件夹（D1a）。已有文件夹（含懒建
 * 之后）/ 云端逃生口 / 非桌面 → null：要么按文件夹绑定解析，要么裸聊懒建走云端（现行为不变）。
 */
export async function pendingLocalContainerRoot(
  conversationId: string,
): Promise<string | null> {
  if (!isDesktop()) return null;
  if (cloudEscapeConversations.has(conversationId)) return null;
  const folderId =
    getConversations().find((c) => c.id === conversationId)?.folderId ?? null;
  if (folderId) return null; // 已归档 / 懒建后——服务端按文件夹绑定解析，不再懒建
  return ensureDefaultContainerRoot();
}
