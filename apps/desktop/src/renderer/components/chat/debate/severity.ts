import { statusPillInline } from "@/components/ui/tone-presets";
import type { DebateBriefInfo, DebateSideInfo } from "@/types/events";

/**
 * 红队风险严重度三档 → 展示元数据（与后端 `risk_severities` 的 high/medium/low 同口径）——**单一源**：
 * 流末终审的完整「风险看板」（{@link import("./Brief").BriefCard} 内 RiskBoard）与裁判台的紧凑「风险
 * 盘口」（{@link import("./DebateHud").RiskGlance}）共用这一套档位语义 / 配色 / 排序，避免两处各写一套
 * 危度色而漂移。注意语义与 `confidencePill` 相反：风险 high=最坏=destructive(红)、low=最轻=muted(灰)，
 * 故另起一套而非复用置信色。`rank` 决定看板 / 盘口内由危到轻的排序。
 */
export const RISK_SEVERITY = {
  high: {
    label: "高危",
    rank: 0,
    pill: statusPillInline.destructive,
    surface: "border-l-2 border-destructive/50 pl-2.5",
  },
  medium: {
    label: "中危",
    rank: 1,
    pill: statusPillInline.destructive,
    surface: "border-l-2 border-destructive/50 pl-2.5",
  },
  low: {
    label: "低危",
    rank: 2,
    pill: statusPillInline.muted,
    surface: "border-l-2 border-border pl-2.5",
  },
} as const;
export type RiskLevel = keyof typeof RISK_SEVERITY;
export const RISK_LEVELS = ["high", "medium", "low"] as const;
export type RiskItem = {
  side: DebateSideInfo;
  text: string;
  level: RiskLevel | null;
};

/** 把后端风险严重度（已归一为 high/medium/low）映射成档位；容忍中文「高/中/低」与同义词，识别不到
 * （如旧产物无此字段）返回 null = 未评级（看板 / 盘口降级为中性卡，不杜撰档位）。 */
export function riskLevelOf(raw: string | undefined): RiskLevel | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if ((RISK_LEVELS as readonly string[]).includes(s)) return s as RiskLevel;
  if (s.includes("high") || raw.includes("高")) return "high";
  if (s.includes("low") || raw.includes("低")) return "low";
  if (s.includes("medium") || raw.includes("中")) return "medium";
  return null;
}

export function rankOf(level: RiskLevel | null): number {
  return level ? RISK_SEVERITY[level].rank : 99;
}

/**
 * 从 roster + brief 建红队风险清单（每条 = 一名非被审方成员的最尖锐风险 = 其「最强论点」，按严重度分级）。
 * 被审方案方（`is_subject`）不入清单——其 `strongest_point` 是抗辩而非风险。无 `strongest_point` 的丢弃。
 * **单一源**：{@link import("./Brief").BriefCard} 风险看板与 {@link import("./DebateHud").RiskGlance}
 * 风险盘口共用此构建，保证两处「哪些算风险、按谁分级」完全一致。
 */
export function buildRiskItems(
  sides: DebateSideInfo[],
  brief: DebateBriefInfo,
): RiskItem[] {
  const severities = brief.risk_severities ?? {};
  return sides
    .filter((s) => !s.is_subject)
    .map((s) => ({
      side: s,
      text: brief.strongest_points[s.key],
      level: riskLevelOf(severities[s.key]),
    }))
    .filter((r): r is RiskItem => Boolean(r.text));
}

/** 风险清单按档位计数（盘口）——高 / 中 / 低各几条，未评级不计。看板与盘口共用。 */
export function riskCounts(risks: RiskItem[]): Record<RiskLevel, number> {
  const counts: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0 };
  for (const r of risks) {
    if (r.level) counts[r.level] += 1;
  }
  return counts;
}
