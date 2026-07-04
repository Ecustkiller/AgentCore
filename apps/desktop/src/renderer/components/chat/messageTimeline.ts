import type { HandoffJob } from "@/services/handoff";
import type { MemoryUpdate, Message } from "@/stores/conversation";

export type TimelineItem =
  | { kind: "message"; at: number; key: string; msg: Message }
  | { kind: "task"; at: number; key: string; job: HandoffJob }
  | { kind: "memory"; at: number; key: string; update: MemoryUpdate };

// Same-timestamp ordering for the message/task base timeline: a turn's message comes
// first, then any background task it spawned. Memory cards are NOT ordered here — they
// snap to exchange boundaries below, not to a raw timestamp slot.
const KIND_ORDER: Record<TimelineItem["kind"], number> = {
  message: 0,
  task: 1,
  memory: 2,
};

/**
 * 把消息、后台云端任务、记忆更新卡并成一条时间线。
 *
 * 消息 + 任务按 `created_at` 排成「基准时间线」；记忆卡则**锚定到它所在那一回合的末尾**
 * ——AI 回答完成之后、下一次提问之前——而非按裸时间戳就地插。原因：offline-consolidation
 * 是回合结束后异步跑的（略滞后），而助手消息落库用的是「回合完成」时刻的时间戳；裸时间戳
 * 排序会让一张滞后的记忆卡正好落在「新提问 ↔ 长回合回答」之间，被夹进问答对里。锚到回合
 * 末尾既不打断问答对，又让每回合各一张、按时间分布，不会退回「全堆在对话最底部」的老毛病
 * （记忆更新对话内可见 §1.6）。无任务且无记忆卡时退化为纯消息列表（最常见路径）。
 */
export function mergeTimeline(
  messages: Message[],
  tasks: HandoffJob[],
  memoryUpdates: MemoryUpdate[] = [],
): TimelineItem[] {
  if (tasks.length === 0 && memoryUpdates.length === 0) {
    return messages.map((msg) => ({
      kind: "message",
      at: Date.parse(msg.createdAt) || 0,
      key: `m:${msg.id}`,
      msg,
    }));
  }

  const base: TimelineItem[] = [
    ...messages.map(
      (msg): TimelineItem => ({
        kind: "message",
        at: Date.parse(msg.createdAt) || 0,
        key: `m:${msg.id}`,
        msg,
      }),
    ),
    ...tasks.map(
      (job): TimelineItem => ({
        kind: "task",
        at: Date.parse(job.createdAt) || 0,
        key: `t:${job.id}`,
        job,
      }),
    ),
  ];
  base.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  if (memoryUpdates.length === 0) return base;

  // Memory cards, oldest-first, each dropped just before the NEXT user message that
  // starts after it (= the end of the exchange active at its `created_at`), or at the
  // very tail when no later turn exists. A user message is the only exchange boundary;
  // assistant replies / tasks belong to that exchange, so a card always lands after them.
  const mems: TimelineItem[] = memoryUpdates
    .map(
      (update): TimelineItem => ({
        kind: "memory",
        at: Date.parse(update.createdAt) || 0,
        key: `mem:${update.id}`,
        update,
      }),
    )
    .sort((a, b) => a.at - b.at);

  const result: TimelineItem[] = [];
  let mi = 0;
  for (const item of base) {
    if (item.kind === "message" && item.msg.role === "user") {
      while (mi < mems.length && mems[mi].at < item.at) {
        result.push(mems[mi++]);
      }
    }
    result.push(item);
  }
  while (mi < mems.length) result.push(mems[mi++]);

  return result;
}
