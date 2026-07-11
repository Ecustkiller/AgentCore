import { Button } from "@/components/ui";
import { cleanSourceTitle } from "@/lib/citations";
import { usePersistentDisclosure } from "@/stores/disclosure";
import type { Citation } from "@/types/events";
import { ChevronDown, ChevronUp, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
 * domain and snippet per source. A `flash` request (from clicking an inline `[n]`
 * chip) expands if needed, scrolls the matching card into view, and highlights it.
 */
const COLLAPSED_COUNT = 3;
/** How many favicons to stack as a preview inside the overflow chip. */
const STACK_PREVIEW = 3;

/** Target signal from an inline citation chip; `nonce` re-triggers on re-click. */
export interface CitationFlash {
  index: number;
  nonce: number;
}

export function SourceCards({
  citations,
  flash,
  referenced,
  turnKey,
}: {
  citations: Citation[];
  flash?: CitationFlash | null;
  /** 1-based source numbers actually cited in the reply body. Sources not in
   * this set are dimmed as "retrieved but not cited"; empty/undefined disables
   * dimming (e.g. a reply with sources but no inline `[n]` markers). */
  referenced?: Set<number>;
  /** 回合作用域（= messageId）：给了才把「展开全部」跨卸载/刷新记住。 */
  turnKey?: string;
}) {
  const [expanded, setExpanded] = usePersistentDisclosure(
    turnKey ? `${turnKey}:sources` : null,
    false,
  );
  const [highlight, setHighlight] = useState<number | null>(null);
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const hlTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Respond to an inline citation click: reveal (if collapsed), scroll, flash.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on flash.nonce so each click (even same index) re-triggers.
  useEffect(() => {
    if (!flash) return;
    const { index } = flash;
    if (index < 1 || index > citations.length) return;
    if (index > COLLAPSED_COUNT) setExpanded(true);
    setHighlight(index);
    clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlight(null), 1400);
    // Scroll after the (possible) expand has committed to the DOM.
    const raf = requestAnimationFrame(() => {
      refs.current[index - 1]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [flash?.nonce, citations.length]);

  useEffect(() => () => clearTimeout(hlTimer.current), []);

  if (citations.length === 0) return null;

  const hidden = citations.length - COLLAPSED_COUNT;
  const collapsed = citations.slice(0, COLLAPSED_COUNT);
  const stack = citations.slice(
    COLLAPSED_COUNT,
    COLLAPSED_COUNT + STACK_PREVIEW,
  );

  const isHighlighted = (i: number) => highlight === i + 1;

  const hasRefs = !!referenced && referenced.size > 0;
  // Dim sources the answer retrieved but never cited inline, so the cited ones
  // stand out; hover restores full opacity so muted sources stay inspectable.
  const dimClass = (i: number) =>
    hasRefs && !referenced?.has(i + 1)
      ? "opacity-55 transition-opacity hover:opacity-100"
      : "";

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
                · {referenced?.size} 条被引用
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
              · {referenced?.size} 条被引用
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
            {citations.map((c, i) => (
              <a
                key={`${c.url}-${i}`}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`来源 ${i + 1}：${cleanSourceTitle(c.title) || c.site || c.url}`}
                className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent ${isHighlighted(i) ? "bg-accent ring-2 ring-primary" : ""} ${dimClass(i)}`}
              >
                <span
                  className={`mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums ${isHighlighted(i) ? "font-medium text-primary" : "text-muted-foreground"}`}
                >
                  {i + 1}
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
            ))}
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
          {collapsed.map((c, i) => (
            <SourceTooltip key={`${c.url}-${i}`} citation={c} index={i + 1}>
              <a
                ref={(el) => {
                  refs.current[i] = el;
                }}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`来源 ${i + 1}：${cleanSourceTitle(c.title) || c.site || c.url}`}
                className={`flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-2 pr-2.5 transition-colors hover:bg-accent ${isHighlighted(i) ? "ring-2 ring-primary" : ""} ${dimClass(i)}`}
              >
                <span className="tabular-nums text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <Favicon site={c.site} title={c.title} size={16} />
                <span className="max-w-[140px] truncate text-xs text-foreground">
                  {c.site || c.url}
                </span>
              </a>
            </SourceTooltip>
          ))}
          {hidden > 0 && (
            <Button
              variant="neutral"
              onClick={() => setExpanded(true)}
              className="h-auto gap-1.5 rounded-full border border-border bg-card py-1 pl-2 pr-2.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <span className="flex items-center gap-1.5">
                <span className="flex items-center -space-x-1.5">
                  {stack.map((c, i) => (
                    <Favicon
                      key={`${c.url}-stack-${i}`}
                      site={c.site}
                      title={c.title}
                      size={16}
                      className="ring-2 ring-card"
                    />
                  ))}
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
