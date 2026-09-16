import type { LucideIcon } from "lucide-react";
import { Presentation, ScrollText } from "lucide-react";

export const TOOLBOX_KINDS = ["skills", "creation"] as const;

export type ToolboxKind = (typeof TOOLBOX_KINDS)[number];

export const TOOLBOX_KIND_LABEL: Record<ToolboxKind, string> = {
  skills: "提示词",
  creation: "创作",
};

/** 与命令面板同一套符号。 */
export const TOOLBOX_KIND_ICON: Record<ToolboxKind, LucideIcon> = {
  skills: ScrollText,
  creation: Presentation,
};

/** 市场只卖提示词。创作不进货架。 */
export const MARKET_KINDS = ["skills"] as const;

export type MarketKind = (typeof MARKET_KINDS)[number];

export function isMarketKind(value: string | null): value is MarketKind {
  return value != null && (MARKET_KINDS as readonly string[]).includes(value);
}
