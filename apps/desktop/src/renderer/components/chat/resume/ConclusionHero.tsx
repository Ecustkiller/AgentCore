import { cn } from "@/lib/utils";
import { useState } from "react";

/** 结论超过此长度（或含换行）默认两行截断，可展开全文。 */
export const CONCLUSION_CLAMP_CHARS = 60;

/** Shared conclusion block — cold plan_review resume (+ future hot reuse). */
export function ConclusionHero({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CONCLUSION_CLAMP_CHARS || text.includes("\n");
  return (
    <div className="mt-1">
      <p
        className={cn(
          "whitespace-pre-wrap text-sm leading-relaxed text-foreground/90",
          !open && long && "line-clamp-2",
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          data-testid="plan-review-conclusion-toggle"
        >
          {open ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}
