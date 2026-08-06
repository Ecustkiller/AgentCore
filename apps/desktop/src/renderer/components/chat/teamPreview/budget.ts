/** team_preview cold/hot 共用辩论轮次预算文案（防双体漂移）。 */
export function formatDebateBudgetLabel(
  maxRounds: number,
  thorough: boolean,
): string {
  if (maxRounds > 0) {
    return thorough
      ? `认真辩透 · 上限 ${maxRounds} 轮`
      : `快速对碰 · ${maxRounds} 轮`;
  }
  return thorough ? "认真辩透" : "快速对碰";
}
