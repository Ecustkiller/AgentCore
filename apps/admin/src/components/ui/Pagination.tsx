import { Button } from "@/components/ui/Button";
import { fmtInt } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * One pager for every list page (four hand-rolled variants used to disagree on
 * alignment, whether buttons had labels, and when to appear at all).
 *
 * The total is always shown — pages that only rendered it inside the pager left
 * small result sets with no count anywhere — while the page stepper appears only
 * when there is somewhere to step to.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Held down during a fetch so a double-click can't skip a page. */
  disabled?: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, totalPages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
      <span className="tabular-nums">
        {total === 0
          ? "共 0 条"
          : `第 ${fmtInt(first)}–${fmtInt(last)} 条 · 共 ${fmtInt(total)} 条`}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            aria-label="上一页"
            disabled={disabled || current <= 1}
            onClick={() => onPageChange(Math.max(1, current - 1))}
          >
            <ChevronLeft size={14} />
          </Button>
          <span className="tabular-nums">
            {current} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="下一页"
            disabled={disabled || current >= totalPages}
            onClick={() => onPageChange(current + 1)}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}
