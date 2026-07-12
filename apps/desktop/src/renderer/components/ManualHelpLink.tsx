import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { manualHref } from "@/pages/toolbox/manual/sectionIds";
import { HelpCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * 产品手册深链（功能现场 ? 入口单一登记处）。
 * 节 ID 来自 sectionIds.ts，禁止手写 path 字符串。
 */
export const MANUAL_HELP = {
  debate: manualHref("collaboration", "debate"),
  checkpoint: manualHref("collaboration", "checkpoint"),
  legend: manualHref("mechanism", "legend"),
} as const;

/**
 * 低调圆形「?」手册入口：hover 提示「看手册说明」，点击深链到产品手册对应节。
 * 三处功能界面（辩论室 / 检查点拍板 / 协作图）共用，形态统一。
 */
export function ManualHelpLink({
  to,
  className,
}: {
  to: string;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <SimpleTooltip label="看手册说明">
      <button
        type="button"
        aria-label="看手册说明"
        data-manual-help={to}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
          "text-muted-foreground/60 transition-colors",
          "hover:bg-accent hover:text-muted-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
        onClick={(e) => {
          e.stopPropagation();
          navigate(to);
        }}
      >
        <HelpCircle size={12} strokeWidth={2} aria-hidden />
      </button>
    </SimpleTooltip>
  );
}
