import { statusPillInline } from "@/components/ui/tone-presets";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cleanSourceTitle } from "@/lib/citations";
import type { Citation } from "@/types/events";
import type { ComponentProps, ReactNode } from "react";
import { Favicon } from "./Favicon";

/**
 * Hover preview for a web source rewritten from `#rN` / `[n]`: favicon, domain,
 * full title, snippet, and a positive-only 已读 mark when the page was fetched.
 */
export function SourcePreview({ citation }: { citation: Citation }) {
  const { title, site, snippet, url, deep_read } = citation;
  const displayTitle = cleanSourceTitle(title);
  return (
    <div className="w-72 max-w-[80vw]">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Favicon site={site} title={title} size={16} />
        <span className="min-w-0 flex-1 truncate">{site || url}</span>
        {deep_read ? (
          <span
            className={`inline-flex shrink-0 items-center ${statusPillInline.success}`}
            title="团队已读取该页全文"
          >
            已读
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 line-clamp-2 text-sm font-medium text-foreground">
        {displayTitle || url}
      </div>
      {snippet && (
        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {snippet}
        </p>
      )}
    </div>
  );
}

/** Wraps a trigger so hovering/focusing it shows the {@link SourcePreview}. */
export function SourceTooltip({
  citation,
  side,
  children,
}: {
  citation: Citation;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-none p-3">
        <SourcePreview citation={citation} />
      </TooltipContent>
    </Tooltip>
  );
}
