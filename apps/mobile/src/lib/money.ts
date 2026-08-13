/**
 * 金额币种符号（手机端）。
 *
 * 后端每笔金额都自带 `currency`：平台记账 / 额度是人民币（curated 国内官价），
 * BYOK 估算是美元（社区价目快照）。**全系统无汇率换算**——这里只把 ISO code 换成
 * 符号，绝不折算，也绝不按 `pricing_source` 猜币种。
 */

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$" };

/** 缺省币种：后端未下发 `currency` 时（旧 wire）按记账台账口径兜底。 */
export const DEFAULT_CURRENCY = "CNY";

/** 币种代码 → 展示符号；未知币种退化为「CODE 」前缀，不冒充 ¥。 */
export function currencySymbol(currency?: string | null): string {
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}
