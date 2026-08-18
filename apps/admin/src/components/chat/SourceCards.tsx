import { Badge } from "@/components/ui/Badge";
import type { NormalizedCitation } from "@/components/chat/chatTurn";

export function SourceCards({
  citations,
}: {
  citations: NormalizedCitation[];
}) {
  if (citations.length === 0) return null;
  return (
    <ul aria-label="来源" className="space-y-2">
      {citations.map((c, i) => (
        <li
          key={c.id || `${c.url}-${i}`}
          className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">
              {c.title || c.url || "来源"}
            </span>
            {c.tier && <Badge tone="neutral">{c.tier}</Badge>}
            {c.site && (
              <span className="text-muted-foreground text-xs">{c.site}</span>
            )}
          </div>
          {c.url && (
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 block truncate text-xs text-primary"
            >
              {c.url}
            </a>
          )}
          {c.snippet && (
            <p className="mt-1 text-muted-foreground text-xs">{c.snippet}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
