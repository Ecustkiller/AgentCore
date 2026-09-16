/**
 * Live 用时的墙钟流逝秒数。展示走 `formatDurationSec`，禁止再拼裸秒。
 *
 * 离线 preview / 挂起流若 `startedAt` 来自合成事件时间戳，相对 `Date.now()` 可能算出
 * 千万级秒数。超过 {@link MAX_SANE_RUNNING_ELAPSED_SEC} 时返回 0，调用方据此省略后缀。
 */
export const MAX_SANE_RUNNING_ELAPSED_SEC = 36 * 60 * 60; // 36h

export function runningElapsedSec(
  startedAtMs: number | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (startedAtMs == null || !Number.isFinite(startedAtMs)) return 0;
  const sec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return sec > MAX_SANE_RUNNING_ELAPSED_SEC ? 0 : sec;
}

/** ISO / 任意 Date.parse 可吃的字符串 → epoch ms；坏值省略秒表。 */
export function startedAtFromIso(
  iso: string | null | undefined,
): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * 助手气泡脚完成时刻：开跑 `createdAt` + 整轮墙钟 `durationMs`。
 * 缺用时 / 非法起点的老行回落开始时刻，不编造完成点。
 */
export function completedAtIso(
  startedAt: string,
  durationMs?: number | null,
): string {
  if (durationMs == null || durationMs <= 0) return startedAt;
  const t = startedAtFromIso(startedAt);
  if (t == null) return startedAt;
  return new Date(t + durationMs).toISOString();
}
