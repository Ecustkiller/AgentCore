import { Badge } from "@/components/ui/badge";
import {
  CircleOff,
  CircleSlash,
  type LucideIcon,
  Repeat,
  TrendingDown,
} from "lucide-react";

const META: Record<
  string,
  { label: string; Icon: LucideIcon; tone: "muted" | "warning" }
> = {
  cancelled: {
    label: "已中断 · 已保存完成的部分",
    Icon: CircleSlash,
    tone: "muted",
  },
  max_rounds: {
    label: "已达最大轮次 · 提前收尾",
    Icon: Repeat,
    tone: "warning",
  },
  degraded: {
    label: "降级完成 · 模型多次空响应",
    Icon: TrendingDown,
    tone: "warning",
  },
  unproductive: {
    label: "无有效进展 · 提前收尾",
    Icon: CircleOff,
    tone: "warning",
  },
};

/** Top-of-bubble chip for abnormal turn endings (前端UX设计.md §一B finishReasonChip). */
export function FinishReasonChip({
  reason,
  className,
}: {
  reason: string | undefined;
  className?: string;
}) {
  const meta = reason ? META[reason] : undefined;
  if (!meta) return null;
  const { label, Icon, tone } = meta;
  return (
    <Badge
      tone={tone === "warning" ? "warning" : "muted"}
      pill
      className={`mb-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 font-normal ${className ?? ""}`}
    >
      <Icon size={14} />
      {label}
    </Badge>
  );
}
