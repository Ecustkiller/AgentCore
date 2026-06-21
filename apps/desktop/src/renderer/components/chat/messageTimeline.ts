import type { HandoffJob } from "@/services/handoff";
import type { Message } from "@/stores/conversation";

export type TimelineItem =
  | { kind: "message"; at: number; key: string; msg: Message }
  | { kind: "task"; at: number; key: string; job: HandoffJob };

/**
 * 把消息与后台云端任务并成一条按时间排序的时间线。等时间戳时消息排在任务前（任务由
 * 消息触发，自然落其后）。任务为空时退化为纯消息列表（最常见路径）。
 */
export function mergeTimeline(
  messages: Message[],
  tasks: HandoffJob[],
): TimelineItem[] {
  if (tasks.length === 0) {
    return messages.map((msg) => ({
      kind: "message",
      at: Date.parse(msg.createdAt) || 0,
      key: `m:${msg.id}`,
      msg,
    }));
  }
  const merged: TimelineItem[] = [
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
  merged.sort(
    (a, b) =>
      a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "message" ? -1 : 1),
  );
  return merged;
}
