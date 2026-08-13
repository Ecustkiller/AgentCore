/**
 * 「哪个对话在等你」——账号级 firehose 信号 `ai_attention`（云对话多端同权 B2 · L1）。
 *
 * 回合停在阻塞卡上时后端往 `/v1/realtime` 发 `required`，任一端放行（或超时 / 孤儿 /
 * Stop）后发 `resolved`。这条信号**只带对话与一行标题、不带卡的正文**——正文永远由该
 * 对话自己的流 / REST 重取（设计 §2.2「只送信号不送内容」）。
 *
 * 本存储只回答一个问题：**哪些对话正停着等人**。用途是让用户人不在那个对话页时也看得见
 * ——侧栏「等你」灯（{@link useConversationAwaitingAttention}）与跨对话提醒都读它。对话页
 * 内真正的可操作面仍是 ApprovalPrompt / ResumePrompt，权威是 InteractionStore 与 recovery
 * 快照，本存储不参与。
 *
 * 没有跨对话的挂起快照接口，所以断线期间漏掉的 `resolved` 补不回来——由「打开该对话即清」
 * 兜底（{@link clearAiAttentionForConversation}）：进了那个对话，页内快照就是权威。
 */
import { create } from "zustand";

/** `/v1/realtime` 的 `ai_attention` 帧（账号级扁平事件，不是回合流的 envelope）。 */
export interface AiAttentionEvent {
  type: "ai_attention";
  state: "required" | "resolved";
  conversation_id: string;
  turn_id: string;
  interaction_id: string;
  kind: string;
  title: string;
}

export interface AiAttentionEntry {
  /** 与 InteractionStore 条目 id / pausedTurns.checkpointId 同一个 id（跨通道去重靠它）。 */
  interactionId: string;
  conversationId: string;
  turnId: string;
  kind: string;
  /** ≤120 字的一行标题（卡自己的问题，或该 kind 的通用文案）。 */
  title: string;
}

interface AiAttentionState {
  /** 按到达先后排列——提醒不跳序。 */
  entries: AiAttentionEntry[];
  apply: (event: AiAttentionEvent) => void;
  clearConversation: (conversationId: string) => void;
  clear: () => void;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const useAiAttentionStore = create<AiAttentionState>((set) => ({
  entries: [],

  apply: (event) => {
    const interactionId = text(event.interaction_id);
    const conversationId = text(event.conversation_id);
    if (!interactionId || !conversationId) return; // 字段缺失的帧直接丢弃

    if (event.state === "resolved") {
      set((state) => {
        const next = state.entries.filter(
          (e) => e.interactionId !== interactionId,
        );
        return next.length === state.entries.length ? state : { entries: next };
      });
      return;
    }
    if (event.state !== "required") return;

    const entry: AiAttentionEntry = {
      interactionId,
      conversationId,
      turnId: text(event.turn_id),
      kind: text(event.kind),
      title: text(event.title),
    };
    set((state) => {
      const index = state.entries.findIndex(
        (e) => e.interactionId === interactionId,
      );
      if (index < 0) return { entries: [...state.entries, entry] };
      // 同一 interaction 重发（多端 / 重连补发）：更新文案但留在原位。
      const next = state.entries.slice();
      next[index] = entry;
      return { entries: next };
    });
  },

  clearConversation: (conversationId) =>
    set((state) => {
      if (!conversationId) return state;
      const next = state.entries.filter(
        (e) => e.conversationId !== conversationId,
      );
      return next.length === state.entries.length ? state : { entries: next };
    }),

  clear: () =>
    set((state) => (state.entries.length === 0 ? state : { entries: [] })),
}));

/** 应用一帧 `ai_attention`（realtime firehose 的唯一入口）。 */
export function applyAiAttention(event: AiAttentionEvent): void {
  useAiAttentionStore.getState().apply(event);
}

/**
 * 打开某对话即清它的提醒——该页自己会呈现真正的卡片（灯改由 InteractionStore /
 * pausedTurns 点亮），也兜住断线期间漏收的 `resolved`。
 */
export function clearAiAttentionForConversation(conversationId: string): void {
  useAiAttentionStore.getState().clearConversation(conversationId);
}

/** 清空——提醒是会话内的东西，登出 / 关流即作废。 */
export function clearAiAttention(): void {
  useAiAttentionStore.getState().clear();
}

/** 该对话是否正停着等人（跨对话信号；与页内卡的判定并联点亮侧栏灯）。 */
export function useConversationAwaitingAttention(
  conversationId: string,
): boolean {
  return useAiAttentionStore((s) =>
    s.entries.some((e) => e.conversationId === conversationId),
  );
}

/** 快照读（非 React 调用方：跨对话提醒的去重与对账）。 */
export function aiAttentionEntries(): readonly AiAttentionEntry[] {
  return useAiAttentionStore.getState().entries;
}
