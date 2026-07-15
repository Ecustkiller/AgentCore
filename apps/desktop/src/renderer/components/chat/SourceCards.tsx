import { Button } from "@/components/ui";
import type { CitationDisplayMap } from "@/lib/citationDisplayMap";
import { cleanSourceTitle } from "@/lib/citations";
import { usePersistentDisclosure } from "@/stores/disclosure";
import type { Citation } from "@/types/events";
import { ChevronDown, ChevronUp, Globe } from "lucide-react";
import { Favicon } from "./Favicon";
import { SourceTooltip } from "./SourcePreview";

/**
 * Source cards under an assistant reply: the web pages the agent searched /
 * read this turn (from the backend `citations` event + persisted on the
 * message). Each card opens its URL in the system browser — the Electron main
 * process routes target=_blank through shell.openExternal.
 *
 * Layout follows the Perplexity / ChatGPT pattern. Collapsed: a single row of
 * compact favicon pills (index + favicon + domain) with a matching overflow pill
 * that stacks the hidden sources' favicons, so a source-heavy answer stays one
 * tidy row; the page title lives in the hover preview and the expanded list.
 * Expanded: a borderless vertical list with a leading index, favicon, title,
 * domain and snippet per source.
 *
 * Display numbers come from {@link CitationDisplayMap} (first-appearance order
 * in the reply body); chips and cards share the same map.
 */
const COLLAPSED_COUNT = 3;
/** How many favicons to stack as a preview inside the overflow chip. */
const STACK_PREVIEW = 3;

export function SourceCards({
  citations,
  displayMap,
  turnKey,
}: {
  citations: Citation[];
  /** Shared renumbering with inline chips; when omitted, pool order + 1-based. */
  displayMap?: CitationDisplayMap | null;
  /** 回合作用域（= messageId）：给了才把「展开全部」跨卸载/刷新记住。 */
  turnKey?: string;
}) {
  const [expanded, setExpanded] = usePersistentDisclosure(
    turnKey ? `${turnKey}:sources` : null,
    false,
  );

  if (citations.length === 0) return null;

  const rows =
    displayMap?.rows ??
    citations.map((_, i) => ({
      poolIndex: i,
      display: i + 1,
      cited: false,
    }));

  const referencedDisplay = displayMap?.referencedDisplay;
  const hasRefs = !!referencedDisplay && referencedDisplay.size > 0;
  const citedCount = referencedDisplay?.size ?? 0;

  const hidden = rows.length - COLLAPSED_COUNT;
  const collapsed = rows.slice(0, COLLAPSED_COUNT);
  const stack = rows.slice(COLLAPSED_COUNT, COLLAPSED_COUNT + STACK_PREVIEW);

  // Dim sources the answer retrieved but never cited inline, so the cited ones
  // stand out; hover restores full opacity so muted sources stay inspectable.
  const dimClass = (cited: boolean) =>
    hasRefs && !cited ? "opacity-55 transition-opacity hover:opacity-100" : "";

  return (
    <div className="mt-3">
      {hidden > 0 ? (
        <Button
          variant="ghost"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mb-1.5 h-auto gap-1.5 px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          <span className="flex items-center gap-1.5">
            <Globe size={14} className="shrink-0" />
            <span>来源 {citations.length}</span>
            {hasRefs && (
              <span className="text-muted-foreground/70">
                · {citedCount} 条被引用
              </span>
            )}
            {expanded ? (
              <ChevronUp size={14} className="ml-0.5" />
            ) : (
              <ChevronDown size={14} className="ml-0.5" />
            )}
          </span>
        </Button>
      ) : (
        <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Globe size={14} className="shrink-0" />
          <span>来源 {citations.length}</span>
          {hasRefs && (
            <span className="text-muted-foreground/70">
              · {citedCount} 条被引用
            </span>
          )}
        </div>
      )}
      {expanded ? (
        // Expanded: a vertical list with each source's snippet inline, like the
        // ChatGPT sources panel. Snippet is shown directly, so no hover preview.
        // Height is capped with internal scroll so a source-heavy answer (up to
        // 24) doesn't stretch the message; the 收起 button stays outside the
        // scroll area so it's always reachable.
        <div>
          <div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1">
            {rows.map(({ poolIndex, display, cited }) => {
              const c = citations[poolIndex];
              if (!c) return null;
              return (
                <a
                  key={`${c.url}-${display}`}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`来源 ${display}：${cleanSourceTitle(c.title) || c.site || c.url}`}
                  className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent ${dimClass(cited)}`}
                >
                  <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {display}
                  </span>
                  <Favicon
                    site={c.site}
                    title={c.title}
                    size={18}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {cleanSourceTitle(c.title) || c.site || c.url}
                    </span>
                    {c.site && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {c.site}
                      </span>
                    )}
                    {c.snippet && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {c.snippet}
                      </p>
                    )}
                  </span>
                </a>
              );
            })}
          </div>
          {hidden > 0 && (
            <Button
              variant="neutral"
              onClick={() => setExpanded(false)}
              className="mt-1.5 inline-flex w-fit border border-border bg-card text-muted-foreground hover:text-foreground"
              icon={<ChevronUp size={14} />}
            >
              收起
            </Button>
          )}
        </div>
      ) : (
        // Collapsed: a single row of compact favicon pills (index + favicon +
        // domain); hover reveals the title + snippet preview.
        <div className="flex flex-wrap items-center gap-1.5">
          {collapsed.map(({ poolIndex, display, cited }) => {
            const c = citations[poolIndex];
            if (!c) return null;
            return (
              <SourceTooltip
                key={`${c.url}-${display}`}
                citation={c}
                index={display}
              >
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`来源 ${display}：${cleanSourceTitle(c.title) || c.site || c.url}`}
                  className={`flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-2 pr-2.5 transition-colors hover:bg-accent ${dimClass(cited)}`}
                >
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {display}
                  </span>
                  <Favicon site={c.site} title={c.title} size={16} />
                  <span className="max-w-[140px] truncate text-xs text-foreground">
                    {c.site || c.url}
                  </span>
                </a>
              </SourceTooltip>
            );
          })}
          {hidden > 0 && (
            <Button
              variant="neutral"
              onClick={() => setExpanded(true)}
              className="h-auto gap-1.5 rounded-full border border-border bg-card py-1 pl-2 pr-2.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <span className="flex items-center gap-1.5">
                <span className="flex items-center -space-x-1.5">
                  {stack.map(({ poolIndex, display }) => {
                    const c = citations[poolIndex];
                    if (!c) return null;
                    return (
                      <Favicon
                        key={`${c.url}-stack-${display}`}
                        site={c.site}
                        title={c.title}
                        size={16}
                        className="ring-2 ring-card"
                      />
                    );
                  })}
                </span>
                <span className="tabular-nums">+{hidden}</span>
              </span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
