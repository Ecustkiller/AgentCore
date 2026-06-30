/**
 * Shared Tailwind class presets for semantic tones (color-tokens.mdc).
 * Full literal strings so Tailwind v4 keeps them in the build.
 *
 * 极简中性配色：warning(琥珀) 已退役为状态色 —— 行动/需要你 = primary(蓝)，
 * 失败/危险 = destructive(红)，纯分类/被动 = muted(灰)。故 status* 的 `warning`
 * 槽位在此映射为灰；decision shell 的 `warning` 槽位已无消费者（卡片改用 primary）。
 */

/** Brand / caution shells for decision & checkpoint cards. */
export type BrandTone = "primary" | "warning";

/** Execution / outcome chips and resolved records. */
export type StatusTone =
  | "primary"
  | "success"
  | "warning"
  | "destructive"
  | "muted";

export type DecisionShellTone = BrandTone | "neutral";

/** Subtle card border + tinted background. */
export const surfaceSubtle: Record<BrandTone, string> = {
  primary: "border-primary/30 bg-primary/5",
  // 极简中性：warning 槽位已退役，保留键以兼容类型，但映射为中性灰（绝不再出琥珀）。
  warning: "border-border bg-muted/40",
};

/** CTA footer bar on decision cards. */
export const decisionCtaBar: Record<BrandTone, string> = {
  primary: "border-primary/15 bg-primary/10",
  warning: "border-border bg-muted/30",
};

export const decisionShell: Record<DecisionShellTone, string> = {
  ...surfaceSubtle,
  neutral: "border-border bg-muted/40",
};

export const decisionCtaBarAll: Record<DecisionShellTone, string> = {
  ...decisionCtaBar,
  neutral: "border-border bg-muted/30",
};

export const decisionAccentText: Record<DecisionShellTone, string> = {
  primary: "text-primary",
  warning: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

/** Icon / label accent (no background). */
export const statusAccentText: Record<StatusTone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-muted-foreground",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/** Borderless soft fill pill body (pair with rounded-full + padding in JSX). */
export const statusPillSoft: Record<StatusTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-muted text-muted-foreground",
  destructive: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

/** Inline rounded-full status pill (full class string). */
export const statusPillInline: Record<StatusTone, string> = {
  primary: `rounded-full px-1.5 py-0.5 text-xs font-medium ${statusPillSoft.primary}`,
  success: `rounded-full px-1.5 py-0.5 text-xs font-medium ${statusPillSoft.success}`,
  warning: `rounded-full px-1.5 py-0.5 text-xs font-medium ${statusPillSoft.warning}`,
  destructive: `rounded-full px-1.5 py-0.5 text-xs ${statusPillSoft.destructive}`,
  muted: `rounded-full px-1.5 py-0.5 text-xs ${statusPillSoft.muted}`,
};

/** Confidence classification (debate brief) — not run status. */
export const confidencePill: Record<"high" | "medium" | "low", string> = {
  high: statusPillSoft.success,
  medium: statusPillSoft.warning,
  low: statusPillSoft.muted,
};

export const confidenceLabel: Record<"high" | "medium" | "low", string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** Primary text link (expand / drill-down affordance). */
export const textLinkPrimary =
  "inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline";

/** Muted meta count / stop-reason chip in card headers. */
export const countPillMuted =
  "shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground";

/** Round index label in debate narrative. */
export const roundLabelPill =
  "inline-block rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground";

/**
 * Debate round signal dot —— verdict-derived (clash → converge progression), NOT run
 * status (color-tokens.mdc: this is a debate-domain classification). Shared by the
 * narrative timeline rail and the convergence band so a round reads the same in both.
 *  - inflight  当前在飞那轮（尚未裁判）→ 品牌蓝脉动
 *  - converged 收敛终点 → 成功绿
 *  - clash     有真交锋 → 品牌蓝实心
 *  - quiet     各说各话 / 无交锋 → 中性灰
 */
export type DebateSignal = "inflight" | "converged" | "clash" | "quiet";
export const debateSignalDot: Record<DebateSignal, string> = {
  inflight: "bg-primary animate-pulse",
  converged: "bg-success",
  clash: "bg-primary",
  quiet: "bg-muted-foreground/30",
};
export const debateSignalText: Record<DebateSignal, string> = {
  inflight: "text-primary",
  converged: "text-success",
  clash: "text-primary",
  quiet: "text-muted-foreground",
};

/** Brand-tinted panel (brief card, highlighted sections). */
export const brandPanelPrimary = `space-y-3 rounded-lg border p-4 ${surfaceSubtle.primary}`;

/** Neutral inset panels. */
export const surfaceMutedPanel = "rounded-lg border border-border bg-muted/30";
export const surfaceMutedPanelLight =
  "rounded-lg border border-border bg-muted/20";

/** Verdict / toggle pill — active = primary, inactive = muted. */
export function verdictTogglePill(active: boolean): string {
  return `rounded-full px-1.5 py-0.5 text-xs ${
    active ? statusPillSoft.primary : statusPillSoft.muted
  }`;
}

/** Graph node classification badge with optional leading icon. */
export const graphBadgePrimary = `flex shrink-0 items-center gap-1 ${statusPillInline.primary}`;
export const graphBadgePrimaryPlain = `shrink-0 ${statusPillInline.primary}`;
export const graphBadgeMuted = `flex shrink-0 items-center gap-1 ${statusPillInline.muted}`;
export const graphBadgeWarning = `flex shrink-0 items-center gap-1 ${statusPillInline.warning}`;
export const graphBadgeDestructive = `flex shrink-0 items-center gap-1 ${statusPillInline.destructive}`;

/** Model tier chip on graph node (no border). */
export const modelTierBadge: Record<"strong" | "fast", string> = {
  strong: statusPillSoft.primary,
  fast: statusPillSoft.muted,
};

/** Run status dot (color-tokens.mdc state mapping). */
export const runStatusDot = {
  pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/30",
} as const;

/** Status / count chip (Badge, inline pills). */
export const statusChip: Record<StatusTone, string> = {
  primary: "border-primary/30 bg-primary/10 text-primary",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-border bg-muted text-muted-foreground",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};

/**
 * Interactive ask_user checkpoint shell. 极简中性：开场引导与途中拍板都用 primary(品牌蓝)
 * ——「邀请你决定」不是警告。`warning` 键保留以兼容类型，但映射为与 primary 相同的蓝（已无琥珀）。
 */
export const interactiveCheckpointTone = {
  primary: {
    wrap: surfaceSubtle.primary,
    accent: "text-primary",
    badge: "bg-primary/10 text-primary",
    optActive: "border-primary bg-primary/10 text-foreground",
    optIdle:
      "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-foreground",
    markActive: "border-primary bg-primary text-primary-foreground",
    dot: "bg-primary-foreground",
    focus: "focus:border-primary/60",
    ctaBar: decisionCtaBar.primary,
    cta: "bg-primary text-primary-foreground hover:bg-primary/90",
  },
  warning: {
    wrap: surfaceSubtle.primary,
    accent: "text-primary",
    badge: "bg-primary/10 text-primary",
    optActive: "border-primary bg-primary/10 text-foreground",
    optIdle:
      "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-foreground",
    markActive: "border-primary bg-primary text-primary-foreground",
    dot: "bg-primary-foreground",
    focus: "focus:border-primary/60",
    ctaBar: decisionCtaBar.primary,
    cta: "bg-primary text-primary-foreground hover:bg-primary/90",
  },
} as const;

/** Settled ask_user record shells. */
export const resolvedCheckpointTone = {
  success: {
    wrap: "border-success/25 bg-success/5",
    badge: "bg-success/10 text-success",
    label: "text-success",
  },
  destructive: {
    wrap: "border-destructive/25 bg-destructive/5",
    badge: "bg-destructive/10 text-destructive",
    label: "text-destructive",
  },
  muted: {
    wrap: "border-border bg-muted/30",
    badge: "bg-muted text-muted-foreground",
    label: "text-muted-foreground",
  },
} as const;

/** Handoff / status card chrome keyed by execution state token. */
export function statusCardChrome(
  tone: "muted" | "primary" | "success" | "destructive",
): { accent: string; border: string; surface: string } {
  switch (tone) {
    case "primary":
      return {
        accent: "text-primary",
        border: "border-primary/30",
        surface: "bg-primary/10",
      };
    case "success":
      return {
        accent: "text-success",
        border: "border-border",
        surface: "bg-card/60",
      };
    case "destructive":
      return {
        accent: "text-destructive",
        border: "border-destructive/30",
        surface: "bg-destructive/10",
      };
    default:
      return {
        accent: "text-muted-foreground",
        border: "border-border",
        surface: "bg-card/60",
      };
  }
}
