import { sourceTitleAndSite } from "@/lib/citations";
import { Favicon } from "./Favicon";

/**
 * One web hit / fetch inventory row: index · favicon · title · domain, snippet
 * below. Shared by search results and the merged Read-page collection.
 */
export function SourceHitRow({
  index,
  url,
  title,
  site,
  snippet,
}: {
  index: number;
  url: string;
  title?: string;
  site?: string;
  snippet?: string;
}) {
  const { title: lineTitle, site: lineSite } = sourceTitleAndSite({
    title,
    site,
    url,
  });
  const label = lineSite ? `${lineTitle} · ${lineSite}` : lineTitle;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`来源 ${index}：${label}`}
      className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
    >
      <span className="mt-0.5 w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {index}
      </span>
      <Favicon site={site} title={title} size={16} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {lineTitle}
          </span>
          {lineSite ? (
            <span className="min-w-0 shrink-0 truncate text-xs font-normal text-muted-foreground">
              · {lineSite}
            </span>
          ) : null}
        </span>
        {snippet ? (
          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
            {snippet}
          </span>
        ) : null}
      </span>
    </a>
  );
}
