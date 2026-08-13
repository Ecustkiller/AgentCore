/**
 * 把服务端下发的**结构化恢复时刻**渲染成用户本机时区的文案（429 / 平台配额闸门）。
 *
 * 服务端不再往文案里写时刻，只给 ISO8601 UTC 绝对时刻，文案退成不含时刻的兜底句。原因是
 * 它只能写死一个时区：线上写的是「8 月 14 日 16:00（UTC）」，而中国用户真正要等的是北京
 * 时间次日零点——照 UTC 读就会算错，回来再撞同一堵墙。
 *
 * 两条规则：
 * - 拿到时刻 → 渲染成本机时区的「8 月 15 日 00:00」，**不标时区名**：渲染出来的就是用户
 *   自己的钟，标了反倒像在说别人的时间。
 * - 拿不到（旧服务端、字段非法、冷加载的 `runs.error` 只有 code + message）→ **原样**转述
 *   服务端那句，绝不自己编一个时间。
 *
 * 桌面端同期做同一件事，两端文案与格式必须逐字一致。
 */

/**
 * 错误上随行的结构化时刻。服务端同期落地，生成类型跟上之前先在此声明形状——两个字段都是
 * 「有就用、没有就闭嘴」，所以旧服务端的响应落到这里也只是全 `undefined`。
 */
export interface RecoveryMomentContext {
  /** 429 / QUOTA_EXCEEDED：上游额度恢复的绝对时刻（ISO8601 UTC）。 */
  recovery_at?: string | null;
  /** 平台配额闸门：配额窗口重置的绝对时刻（ISO8601 UTC）。 */
  reset_at?: string | null;
  /** 措辞分流：user = 用户自己的服务商额度；platform / 缺省 = 上游额度。 */
  credential_source?: string | null;
}

/**
 * ISO8601 时刻 → 本机时区的「8 月 15 日 00:00」；无值 / 非法输入返回 `null`。
 *
 * `timeZone` 只为测试注入一个确定的时区（生产永远走设备本地时区），因为「渲染的是本地时刻」
 * 这件事本身不能靠跑测试的机器碰巧在哪个时区来证明。
 */
export function formatLocalMoment(
  iso: string | null | undefined,
  timeZone?: string,
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("month")} 月 ${pick("day")} 日 ${pick("hour")}:${pick("minute")}`;
}

/** 上游 429 / 平台额度撞墙的整句——线上原文，只把时刻换成本地时刻。 */
function upstreamRecoveryCopy(
  moment: string,
  code: string | null | undefined,
  credentialSource: string | null | undefined,
): string {
  if (code === "QUOTA_EXCEEDED") {
    return `平台模型额度已用完，本回合无法继续。上游将于 ${moment} 恢复；或在「设置 · 服务商」接入自己的 API Key 立即继续。`;
  }
  // BYOK 被限的是用户自己的额度；来源不明时不猜是谁的钱，退回泛指的「上游额度」。
  const whose = credentialSource === "user" ? "你的服务商额度" : "上游额度";
  return `上游限流，本回合无法继续。${whose}将于 ${moment} 恢复，在此之前重试仍会失败。`;
}

/**
 * 给一句服务端错误文案补上本机时区的时刻。没有可用时刻时原样返回。
 *
 * 两种姿势，取决于那句话里还有没有客户端拿不到的东西：
 * - `recovery_at`（上游 429 / 平台额度撞墙）：整句由客户端出。那句话除了时刻没有别的服务端
 *   独有数据，重写一遍最干净，措辞逐字复刻线上原文。
 * - `reset_at`（平台配额闸门）：服务端那句带着「已达每日 token 上限（1,234 / 5,000）」这类
 *   只有它知道的用量数字，客户端无从重写——保留原句，另起一句说重置时刻。
 *
 * 两个字段同时出现时以 `recovery_at` 为准：上游那堵墙比本地配额窗口更晚放行，说早的那个
 * 会让用户白跑一趟。
 */
export function withLocalRecoveryMoment(
  message: string,
  opts: {
    code?: string | null;
    context?: RecoveryMomentContext | null;
  },
): string {
  const context = opts.context;
  const recovery = formatLocalMoment(context?.recovery_at);
  if (recovery) {
    return upstreamRecoveryCopy(
      recovery,
      opts.code,
      context?.credential_source,
    );
  }
  const reset = formatLocalMoment(context?.reset_at);
  if (!reset) return message;
  const base = message.trimEnd();
  const tail = `额度将于 ${reset} 重置。`;
  if (!base) return tail;
  return /[。；！？]$/.test(base) ? `${base}${tail}` : `${base}。${tail}`;
}
