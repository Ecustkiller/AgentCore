/**
 * 「不答会怎样」文案单源（手机端自有实现，与桌面同口径不同实现）。
 *
 * 默认部署下阻塞升级 / 登录等待是**无限期**的（`checkpoint_timeout_seconds` 默认 None）：
 * 没人答就没有任何东西会替用户「按假设继续」，那名队员一直停在原地。卡面若无条件写
 * 「未答则按此继续」，读的人会以为可以先放着，于是去干别的。只有运维显式配了上限
 * （wire `timeout_seconds`）才真会超时回落 assumption——那种部署照实写出上限。
 */

/** 把墙钟上限说成人话；无上限（缺省 / 非正数）返回空串。 */
export function waitCeilingLabel(seconds?: number | null): string {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return "";
  }
  if (seconds < 60) return `${round1(seconds)} 秒`;
  if (seconds < 3600) return `${round1(seconds / 60)} 分钟`;
  return `${round1(seconds / 3600)} 小时`;
}

function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** 待拍板卡上那行「不答会怎样」。 */
export function escalationWaitNote({
  assumption,
  timeoutSeconds,
  awaiting = "user",
}: {
  assumption: string;
  timeoutSeconds?: number | null;
  awaiting?: "user" | "ceo";
}): string {
  const fallback = assumption.trim();
  const ceiling = waitCeilingLabel(timeoutSeconds);
  if (ceiling) {
    const verb = awaiting === "ceo" ? "未裁" : "未答";
    return fallback
      ? `${ceiling}内${verb}则按此继续：${fallback}`
      : `${ceiling}内${verb}则按队员的假设继续`;
  }
  if (awaiting === "ceo") {
    return fallback
      ? `不会自动继续——等主管裁决；暂定假设：${fallback}`
      : "不会自动继续——等主管裁决";
  }
  return fallback
    ? `不会自动继续——这条一直等你；点「按假设继续」才按此走：${fallback}`
    : "不会自动继续——这条一直等你";
}
