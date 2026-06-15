import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Citation } from "@/types/events";
import { Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Source cards under an assistant reply: the web pages the agent searched /
 * read this turn (from the backend `citations` event + persisted on the
 * message). Each card opens its URL in the system browser — the Electron main
 * process routes target=_blank through shell.openExternal.
 *
 * Collapsed to a single row by default; "show all" reveals the rest so a
 * source-heavy answer never pushes the conversation down. A `flash` request
 * (from clicking an inline `[n]` citation chip) expands if needed, scrolls the
 * matching card into view, and briefly highlights it.
 */
const COLLAPSED_COUNT = 3;

/** Target signal from an inline citation chip; `nonce` re-triggers on re-click. */
export interface CitationFlash {
  index: number;
  nonce: number;
}

export function SourceCards({
  citations,
  flash,
}: {
  citations: Citation[];
  flash?: CitationFlash | null;
}) {
  const [expanded, setExpanded] = useState(false);
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
  const visible = expanded ? citations : citations.slice(0, COLLAPSED_COUNT);

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Globe size={14} className="shrink-0" />
        <span>来源 {citations.length}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((c, i) => (
          <SimpleTooltip key={`${c.url}-${i}`} label={c.url}>
            <a
              ref={(el) => {
                refs.current[i] = el;
              }}
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className={`flex max-w-[260px] items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 transition-colors hover:bg-accent ${
                highlight === i + 1
                  ? "border-primary ring-2 ring-primary"
                  : "border-border"
              }`}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">
                  {c.title || c.site || c.url}
                </span>
                {c.site && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.site}
                  </span>
                )}
              </span>
            </a>
          </SimpleTooltip>
        ))}
        {hidden > 0 && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            +{hidden} 更多
          </button>
        )}
      </div>
    </div>
  );
}
