import { SimpleTooltip } from "@/components/ui/tooltip";
import { remarkCitations } from "@/lib/remarkCitations";
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock } from "./CodeBlock";

// Stable references so ReactMarkdown doesn't re-init plugins on every keystroke
// of the streaming content.
const remarkPlugins = [remarkGfm, remarkMath];
// `ignoreMissing` keeps an unknown ```lang from throwing mid-stream.
const rehypePlugins = [[rehypeHighlight, { ignoreMissing: true }], rehypeKatex];
const components: Components = { pre: CodeBlock };

/** A clickable inline citation marker that maps to a source card. */
function CitationChip({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <SimpleTooltip label={`来源 ${n}`}>
      <button
        type="button"
        onClick={onClick}
        className="mx-0.5 inline-flex items-center rounded-full bg-primary/10 px-1.5 align-super text-xs font-medium leading-none text-primary transition-colors hover:bg-primary/20"
      >
        {n}
      </button>
    </SimpleTooltip>
  );
}

interface Props {
  content: string;
  /** Number of source cards; enables `[n]` (1..count) citation chips. */
  citationCount?: number;
  /** Invoked with the 1-based source index when a chip is clicked. */
  onCitationClick?: (n: number) => void;
}

/**
 * Assistant-message Markdown: GFM (tables/strikethrough/task lists), syntax
 * highlighting with a per-block copy button, KaTeX math ($…$ / $$…$$), and —
 * when the message has sources — clickable `[n]` citation chips.
 */
export const Markdown = memo(function Markdown({
  content,
  citationCount = 0,
  onCitationClick,
}: Props) {
  // Only enrich once sources exist (they arrive at end-of-turn), so streaming
  // deltas keep using the stable module-level plugins/components.
  const remarks = useMemo(
    () =>
      citationCount > 0
        ? [...remarkPlugins, remarkCitations(citationCount)]
        : remarkPlugins,
    [citationCount],
  );

  const comps = useMemo<Components>(() => {
    if (citationCount <= 0) return components;
    return {
      pre: CodeBlock,
      a({ href, children, node: _node, ...props }) {
        const m = typeof href === "string" ? /^cite:(\d+)$/.exec(href) : null;
        if (m) {
          const n = Number(m[1]);
          return <CitationChip n={n} onClick={() => onCitationClick?.(n)} />;
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
    };
  }, [citationCount, onCitationClick]);

  return (
    <div className="markdown-body text-foreground">
      <ReactMarkdown
        remarkPlugins={remarks}
        // biome-ignore lint/suspicious/noExplicitAny: plugin tuple typing is loose across unified versions.
        rehypePlugins={rehypePlugins as any}
        components={comps}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
