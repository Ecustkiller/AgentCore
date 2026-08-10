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
