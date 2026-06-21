/**
 * Shared Tailwind class presets for semantic tones (color-tokens.mdc).
 * Full literal strings so Tailwind v4 keeps them in the build.
 */

/** Brand / caution shells for decision & checkpoint cards. */
export type BrandTone = "primary" | "warning";

/** Execution / outcome chips and resolved records. */
export type StatusTone = "primary" | "success" | "warning" | "destructive" | "muted";

export type DecisionShellTone = BrandTone | "neutral";

/** Subtle card border + tinted background. */
export const surfaceSubtle: Record<BrandTone, string> = {
  primary: "border-primary/30 bg-primary/5",
  warning: "border-warning/40 bg-warning/10",
};

/** CTA footer bar on decision cards. */
export const decisionCtaBar: Record<BrandTone, string> = {
  primary: "border-primary/15 bg-primary/10",
  warning: "border-warning/20 bg-warning/10",
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
  warning: "text-warning",
  neutral: "text-muted-foreground",
};

/** Icon / label accent (no background). */
export const statusAccentText: Record<StatusTone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/** Borderless soft fill pill body (pair with rounded-full + padding in JSX). */
export const statusPillSoft: Record<StatusTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
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

/** Brand-tinted panel (brief card, highlighted sections). */
export const brandPanelPrimary = `space-y-3 rounded-lg border p-4 ${surfaceSubtle.primary}`;

/** Neutral inset panels. */
export const surfaceMutedPanel =
  "rounded-lg border border-border bg-muted/30";
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
  warning: "border-warning/40 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};

/** Interactive ask_user checkpoint — primary (opening) vs warning (mid-task fork). */
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
    wrap: surfaceSubtle.warning,
    accent: "text-warning",
    badge: "bg-warning/10 text-warning",
    optActive: "border-warning bg-warning/15 text-foreground",
    optIdle:
      "border-border bg-card text-muted-foreground hover:border-warning/40 hover:bg-accent hover:text-foreground",
    markActive: "border-warning bg-warning text-warning-foreground",
    dot: "bg-warning-foreground",
    focus: "focus:border-warning/60",
    ctaBar: decisionCtaBar.warning,
    cta: "bg-warning text-warning-foreground hover:bg-warning/90",
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
