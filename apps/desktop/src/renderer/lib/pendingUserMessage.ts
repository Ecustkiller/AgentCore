/**
 * 时间线上先不画的用户行 id。
 * 排队快照里的 id，以及仍是「等待读取」的插话所指向的用户行 id。
 * 按 id 分区，不按正文相同去猜。
 */

export function heldUserMessageIds(
  queuedMessageIds: readonly string[],
  receivedUserMessageIds: readonly string[],
): Set<string> {
  const held = new Set<string>();
  for (const id of queuedMessageIds) {
    if (id) held.add(id);
  }
  for (const id of receivedUserMessageIds) {
    if (id) held.add(id);
  }
  return held;
}

export interface SteerWaitItem {
  interjectionId: string;
  content: string;
}

export function steerWaitingItems(
  messages: readonly { role: string }[],
  interjectionsFor: (
    index: number,
  ) =>
    | readonly { interjectionId: string; status: string; content: string }[]
    | undefined,
  queuedInterjectionIds: ReadonlySet<string>,
): SteerWaitItem[] {
  const out: SteerWaitItem[] = [];
  const seen = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    for (const item of interjectionsFor(index) ?? []) {
      if (item.status !== "received") continue;
      if (!item.interjectionId || seen.has(item.interjectionId)) continue;
      if (queuedInterjectionIds.has(item.interjectionId)) continue;
      seen.add(item.interjectionId);
      out.push({
        interjectionId: item.interjectionId,
        content: item.content,
      });
    }
  });
  return out;
}
