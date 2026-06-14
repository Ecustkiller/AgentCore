/** 把字节数格式化为人类可读字符串。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const CJK_RANGE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/**
 * 粗估文本的 token 数，用于流式进度展示（非计费用途）。
 *
 * 真实 token 数只有 LLM 网关在回合结束时给出（usage）；流式过程中每个
 * delta 不带 token，因此这里用「CJK 约 1 token/字，其余约 4 字/token」的
 * 经验启发式给出一个量级感知，足够驱动节点上的实时进度。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RANGE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/** 紧凑数字：1234 → "1.2k"、2_000_000 → "2.0M"（用于 token 等大数展示）。 */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 取文本末尾若干字符并折行成单段预览（用于节点上的实时输出片段）。 */
export function tailText(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `…${flat.slice(flat.length - max)}`;
}

/** 毫秒时长 → 人类可读："45s" / "2m34s" / "1h2m"（用于任务用时摘要）。 */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m${s}s`;
}

/** 1 USD = 10^9 nano-USD：台账/接口里钱的规范单位（整数，绝不用 float）。 */
const NANO_PER_USD = 1_000_000_000;

/**
 * 把整数 nano-USD 成本折算成人民币展示串（大众面，§7.2）。
 *
 * 钱一律以整数 nano-USD 流转（1 USD = 1e9），绝不用 float；汇率 `cnyPerUsd` 由
 * 后端单一来源下发（`/usage/summary`），前端不写死。约定（§7.5）：0 / 无花销显
 * 「—」（不显「¥0.00」）；有花销但折算不足 1 分显「<¥0.01」。
 */
export function formatCost(nanoUsd: number, cnyPerUsd: number): string {
  if (nanoUsd <= 0) return "—";
  const yuan = (nanoUsd / NANO_PER_USD) * cnyPerUsd;
  if (yuan < 0.01) return "<¥0.01";
  return `¥${yuan.toFixed(2)}`;
}

/**
 * 把整数 nano-USD 成本格式化为 USD 展示串（power 面，§7.2）：`$0.0123`。
 *
 * 同 {@link formatCost}：0 / 无花销显「—」；有花销但不足 $0.0001 显「<$0.0001」。
 */
export function formatUsd(nanoUsd: number): string {
  if (nanoUsd <= 0) return "—";
  const usd = nanoUsd / NANO_PER_USD;
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}
