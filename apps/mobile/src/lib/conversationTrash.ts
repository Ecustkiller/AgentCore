/**
 * How long a deleted conversation still has, phrased from the server's
 * `purge_at`. That timestamp is the *earliest* the sweeper may purge (it runs
 * on a cadence), so the day count floors rather than rounds — never promise
 * more time than the server committed to.
 *
 * Written here (not imported from desktop) — each client owns its copy.
 */
export function retentionRemainingLabel(
  purgeAt: string,
  now: number = Date.now(),
): string {
  const left = Date.parse(purgeAt) - now;
  if (Number.isNaN(left)) return "";
  if (left <= 0) return "即将清理";
  const days = Math.floor(left / 86_400_000);
  return days < 1 ? "剩不到 1 天" : `剩 ${days} 天`;
}
