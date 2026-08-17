import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  CircleOff,
  type LucideIcon,
  Repeat,
  TrendingDown,
} from "lucide-react";

/**
 * Abnormal finish-reason labels (bubble chip + footer「收尾原因」).
 * `cancelled` / `interrupted` intentionally omitted — partial body (or team
 * StatusStrip「已停止」) is the terminal signal; chat timeline does not paint a
 * standalone「已停止」row (P1). No “saved” reassurance chip
 * (对齐主流对话 AI · 前端UX设计.md §三).
 *
 * `error` stays in the map so this chip can paint «调用失败» when asked.
 * Callers gate with `showFinishReasonChip` — hard failures are the red card,
 * not a muted chip stacked on top.
 */
export const FINISH_REASON_META: Record<
  string,
  { label: string; Icon: LucideIcon; tone: "muted" }
> = {
  max_rounds: {
    label: "已达最大轮次 · 提前收尾",
    Icon: Repeat,
    tone: "muted",
  },
  degraded: {
    label: "空响应收尾",
    Icon: TrendingDown,
    tone: "muted",
  },
  unproductive: {
    label: "无有效进展 · 提前收尾",
    Icon: CircleOff,
    tone: "muted",
  },
  error: {
    label: "调用失败",
    Icon: AlertTriangle,
    tone: "muted",
  },
};

/** Top-of-bubble chip for soft abnormal endings (前端UX设计.md §一B finishReasonChip). */
export function FinishReasonChip({
  reason,
  diagnosisLabel,
  className,
}: {
  reason: string | undefined;
  /** When degraded due to empty response, show diagnosis instead of the default label. */
  diagnosisLabel?: string;
  className?: string;
}) {
  if (!reason) return null;
  const meta = FINISH_REASON_META[reason];
  if (!meta) return null;
  const { Icon } = meta;
  const label =
    reason === "degraded" && diagnosisLabel ? diagnosisLabel : meta.label;
  return (
    <Badge
      tone="muted"
      pill
      className={`mb-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 font-normal ${className ?? ""}`}
    >
      <Icon size={14} />
      {label}
    </Badge>
  );
}
