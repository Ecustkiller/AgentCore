import { remarkCitations } from "@/lib/remarkCitations";
import type { Citation } from "@/types/events";
import {
  type ComponentPropsWithoutRef,
  isValidElement,
  memo,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock, nodeText } from "./CodeBlock";
import { DiagramBlock } from "./Diagram";
import { faviconUrl } from "./Favicon";
import { SourceTooltip } from "./SourcePreview";

// Stable references so ReactMarkdown doesn't re-init plugins on every keystroke
// of the streaming content.
const remarkPlugins = [remarkGfm, remarkMath];
// `ignoreMissing` keeps an unknown ```lang from throwing mid-stream.
const rehypePlugins = [[rehypeHighlight, { ignoreMissing: true }], rehypeKatex];

/**
 * A tiny inline favicon for a citation chip. Unlike the card {@link Favicon}, it
 * has NO letter fallback: a missing host or a failed load (common for sites with
 * cert issues) renders nothing, so the chip cleanly degrades to a number-only pill
 * mid-sentence instead of an awkward letter glyph in the reading flow.
 */
function ChipFavicon({ site }: { site?: string }) {
  const domain = site?.trim();
  const [failed, setFailed] = useState(false);
  if (!domain || failed) return null;
  return (
    <img
      src={faviconUrl(domain)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-3 shrink-0 rounded-full object-contain"
    />
  );
}

/**
 * A clickable inline citation marker that maps to a source card. Shows the
 * source's favicon (when it loads) before the number so a reader recognizes the
 * site inline; hovering reveals the full source (favicon + title + domain +
 * snippet), matching the source cards below the reply.
 */
function CitationChip({
  n,
  citation,
  onClick,
}: {
  n: number;
  citation?: Citation;
  onClick: () => void;
}) {
  const chip = (
    <button
      type="button"
      onClick={onClick}
      aria-label={`跳到来源 ${n}`}
      className="mx-0.5 inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 align-super text-xs font-medium leading-none text-primary transition-colors hover:bg-primary/20"
    >
      <ChipFavicon site={citation?.site} />
      {n}
    </button>
  );
  if (!citation) return chip;
  return (
    <SourceTooltip citation={citation} index={n}>
      {chip}
    </SourceTooltip>
  );
}

interface Props {
  content: string;
  /** Web sources for this message; enables `[n]` (1..count) citation chips with
   * a hover preview of each source. */
  citations?: Citation[];
  /** Invoked with the 1-based source index when a chip is clicked. */
  onCitationClick?: (n: number) => void;
  /** While true, defer rendering ```mermaid/```markmap blocks (a half-written
   * diagram is a syntax error) — they show source until the turn finishes. */
  isStreaming?: boolean;
}

/**
 * Assistant-message Markdown: GFM (tables/strikethrough/task lists), syntax
 * highlighting with a per-block copy button, KaTeX math ($…$ / $$…$$),
 * ```mermaid / ```markmap diagrams (rendered via Diagram.tsx), and — when the
 * message has sources — clickable `[n]` citation chips.
 */
export const Markdown = memo(function Markdown({
  content,
  citations,
  onCitationClick,
  isStreaming = false,
}: Props) {
  const citationCount = citations?.length ?? 0;
  // Only enrich once sources exist (they arrive at end-of-turn), so streaming
  // deltas keep using the stable module-level remark plugins.
  const remarks = useMemo(
    () =>
      citationCount > 0
        ? [...remarkPlugins, remarkCitations(citationCount)]
        : remarkPlugins,
    [citationCount],
  );

  const comps = useMemo<Components>(() => {
    // Route ```mermaid / ```markmap / ```vega-lite fences to the diagram
    // renderer; everything else stays the normal copy-button code block. The
    // language regex allows hyphens so "vega-lite" is captured whole.
    const pre = (props: ComponentPropsWithoutRef<"pre">) => {
      const child = props.children;
      const className = isValidElement(child)
        ? ((child.props as { className?: string }).className ?? "")
        : "";
      const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
      const kind =
        lang === "mermaid" || lang === "markmap"
          ? lang
          : lang === "vega-lite" || lang === "vega" || lang === "vegalite"
            ? "vega-lite"
            : null;
      if (kind) {
        return (
          <DiagramBlock
            kind={kind}
            code={nodeText(child)}
            streaming={isStreaming}
          />
        );
      }
      return <CodeBlock {...props} />;
    };

    if (citationCount <= 0) return { pre };
    return {
      pre,
      a({ href, children, node: _node, ...props }) {
        const m = typeof href === "string" ? /^cite:(\d+)$/.exec(href) : null;
        if (m) {
          const n = Number(m[1]);
          return (
            <CitationChip
              n={n}
              citation={citations?.[n - 1]}
              onClick={() => onCitationClick?.(n)}
            />
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
    };
  }, [citationCount, citations, onCitationClick, isStreaming]);

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
