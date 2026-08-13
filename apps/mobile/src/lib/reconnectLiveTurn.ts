/**
 * 主路断线重连：按 active/live turn id 清空或移除。
 * 出队开跑后队尾可能是新 turn——禁止假定 `turns[turns.length - 1]` 是待续 partial。
 */

/** 重连前清空目标 live turn 的 events（replay 会重灌）；其它 turn 不动。 */
export function clearLiveTurnEvents<
  T extends { id: string; events: unknown[] },
>(turns: T[], liveTurnId: string | null): T[] {
  if (!liveTurnId) return turns;
  const idx = turns.findIndex((t) => t.id === liveTurnId);
  if (idx < 0) return turns;
  const next = turns.slice();
  next[idx] = { ...next[idx], events: [] };
  return next;
}

/** attach 得到 none（已结束）时移除该 live turn；勿 `slice(0, -1)` 误删其它 turn。 */
export function removeLiveTurn<T extends { id: string }>(
  turns: T[],
  liveTurnId: string | null,
): T[] {
  if (!liveTurnId) return turns;
  return turns.filter((t) => t.id !== liveTurnId);
}

/**
 * clear-then-fold：丢掉历史末尾那条 `running` 的助手影子行，让 live 回合独占它的气泡。
 *
 * 一条仍在跑的回合在 `getMessages` 里是一行 `status: "running"` 的部分稿；同一个回合又会经
 * SSE 重放整段折进 live turn。两者同时在场就是同一回合渲染两遍——本端自发流如此，跟播另一端
 * 起的回合（回读历史补用户泡）亦如此。只掐末尾且只掐 running：更早的中断回合是历史事实。
 */
export function dropRunningAssistantTail<
  T extends { role: string; status?: string | null },
>(messages: T[]): T[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "running") {
    return messages;
  }
  return messages.slice(0, -1);
}
