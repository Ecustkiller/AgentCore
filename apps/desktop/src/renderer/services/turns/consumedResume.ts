/**
 * 冷卡「继续」点在一张**已经被处理过**的挂起帧上，而那次续跑也已经结束
 * （`resume_settled` 的 `turn_status ≠ running`）。
 *
 * 这条连接后面不会再有任何帧了。本端刚为这一下点击把挂起气泡乐观翻回了流式，不收口的话
 * 它会一直转；`runMessageStream` 收尾时还会把「流没了但仍在生成」判成掉线，把用户拽进一次
 * 毫无意义的重连。收口之后再把持久化的结局读回来——本端手里还是暂停那一刻的半截回答，
 * 真正的结局（跑完 / 没跑完 / 失败）在服务端。
 */
import { loadLatestWindow } from "@/services/messages";
import { getRuntime, useConversationStore } from "@/stores/conversation";

/**
 * 收口这次「点了个已经结掉的卡」的乐观流式态，并刷回真实结局。
 *
 * 只在尾部助手气泡确实是被续跑的那一条时动手。对不上就什么都不做——同会话另有一轮 live
 * 在跑时（D9 冷卡与 live 并存）那条气泡不归这次点击管，碰它等于打断一次正跑得好好的回合；
 * 这种少见的错位交回既有的「断流 → rejoin」兜底，它一样会收敛到持久化的事实。
 */
export function settleConsumedResume(
  conversationId: string,
  messageId: string,
): void {
  const rt = getRuntime(conversationId);
  const tail = [...rt.messages].reverse().find((m) => m.role === "assistant");
  if (!tail) return;
  if (tail.serverMessageId !== messageId && tail.id !== messageId) return;

  if (rt.isGenerating || tail.isStreaming) {
    useConversationStore.getState().finalizeLastMessage(conversationId);
  }
  // 窗口刷新自带闸（仍在生成 / 切片不在内存都会自行拒绝），失败也只是维持现状。
  void loadLatestWindow(conversationId);
}
