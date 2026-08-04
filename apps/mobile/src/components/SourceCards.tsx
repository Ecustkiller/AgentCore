import { BASE_URL } from "@/api/client";
import type { Citation } from "@agentcore/contract-types";
import { ChevronDown, ChevronUp, Globe } from "lucide-react";
import { useMemo, useState } from "react";
import "@/components/SourceCards.css";

const COLLAPSED_COUNT = 3;
const STACK_PREVIEW = 3;

const CITATION_TIER_LABEL: Record<string, string> = {
  official: "官方",
  media: "媒体",
  unknown: "待评",
  weak: "弱源",
};

const TITLE_SUFFIX = /(?:\s[-|–—]\s|\s*[_｜·]\s*)[^-|_–—｜·\d]{2,20}$/;
const MARKER = /\[(\d+)\]/g;
const LEDGER_MARKER = /#r(\d+)\b/g;

/** Strip trailing "标题 - 站点" suffix for card titles (desktop-aligned). */
function cleanSourceTitle(title?: string): string {
  const t = (title ?? "").trim();
  if (t.length < 8) return t;
  const stripped = t.replace(TITLE_SUFFIX, "").trim();
  return stripped.length >= 2 ? stripped : t;
}

export interface CitationDisplayMap {
  toDisplay: Map<number, number>;
  stableCited: Map<number, number>;
  rows: Array<{ poolIndex: number; display: number; cited: boolean }>;
  referencedDisplay: Set<number>;
}

/**
 * First-appearance renumbering so chips / SourceCards share labels.
 * Local copy of desktop `buildCitationDisplayMap` (no desktop import).
 */
export function buildCitationDisplayMap(
  content: string,
  citationCount: number,
  previous?: ReadonlyMap<number, number> | null,
  citations?: ReadonlyArray<{ id?: string | null }> | null,
): CitationDisplayMap {
  const stableCited = new Map<number, number>(previous ?? undefined);

  if (citationCount > 0 && content) {
    MARKER.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex scan
    while ((m = MARKER.exec(content)) !== null) {
      const canonical = Number(m[1]);
      if (canonical < 1 || canonical > citationCount) continue;
      if (stableCited.has(canonical)) continue;
      stableCited.set(canonical, stableCited.size + 1);
    }
    if (citations?.length) {
      const idToCanonical = new Map<string, number>();
      for (let i = 0; i < citations.length; i++) {
        const id = citations[i]?.id;
        if (id) idToCanonical.set(id, i + 1);
      }
      LEDGER_MARKER.lastIndex = 0;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex scan
      while ((m = LEDGER_MARKER.exec(content)) !== null) {
        const canonical = idToCanonical.get(`#r${m[1]}`);
        if (canonical == null || canonical < 1 || canonical > citationCount) {
          continue;
        }
        if (stableCited.has(canonical)) continue;
        stableCited.set(canonical, stableCited.size + 1);
      }
    }
  }

  const referencedDisplay = new Set(stableCited.values());
  const rows: CitationDisplayMap["rows"] = [];
  const citedOrdered = [...stableCited.entries()].sort((a, b) => a[1] - b[1]);
  for (const [canonical, display] of citedOrdered) {
    rows.push({ poolIndex: canonical - 1, display, cited: true });
  }

  const toDisplay = new Map(stableCited);
  let next = stableCited.size + 1;
  for (let i = 1; i <= citationCount; i++) {
    if (stableCited.has(i)) continue;
    toDisplay.set(i, next);
    rows.push({ poolIndex: i - 1, display: next, cited: false });
    next += 1;
  }

  return { toDisplay, stableCited, rows, referencedDisplay };
}

function CitationTierBadge({ tier }: { tier?: string | null }) {
  if (!tier) return null;
  const label = CITATION_TIER_LABEL[tier];
  if (!label) return null;
  return (
    <span
      className={`cites-tier cites-tier-${tier}`}
      title={`来源可信度：${label}`}
    >
      {label}
    </span>
  );
}

function Favicon({
  site,
  title,
  size = 16,
  className = "",
}: {
  site?: string;
  title?: string;
  size?: number;
  className?: string;
}) {
  const domain = site?.trim();
  const [failedDomain, setFailedDomain] = useState<string | null>(null);
  const letter = (domain || title || "?").charAt(0).toUpperCase();
  const showImg = !!domain && failedDomain !== domain;

  return (
    <span
      className={`cites-favicon ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden
    >
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
 * Source cards under an assistant reply — Perplexity / ChatGPT pattern.
 * Collapsed: compact favicon pills; expanded: vertical list with snippet.
 * No Popover (mobile): ledger id stays a quiet inline label when present.
 * Display numbers from first-appearance in `content`, or an optional shared map.
 */
export function SourceCards({
  items,
  content,
  displayMap: displayMapProp,
}: {
  items: Citation[];
  /** Reply body — used to build first-appearance displayMap locally. */
  content?: string;
  /** Shared renumbering with Markdown chips; when set, wins over `content`. */
  displayMap?: CitationDisplayMap | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const localMap = useMemo(() => {
    if (displayMapProp) return null;
    if (!content || items.length === 0) return null;
    return buildCitationDisplayMap(content, items.length, null, items);
  }, [displayMapProp, content, items]);

  const displayMap = displayMapProp ?? localMap;

  if (items.length === 0) return null;

  const rows =
    displayMap?.rows ??
    items.map((_, i) => ({
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

  const dimClass = (cited: boolean) =>
    hasRefs && !cited ? "cites-dim" : undefined;

  return (
    <div className="cites">
      {hidden > 0 ? (
        <button
          type="button"
          className="cites-header cites-header-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Globe size={14} className="cites-header-icon" aria-hidden />
          <span>{`来源 ${items.length}`}</span>
          {hasRefs ? (
            <span className="cites-header-meta">· {citedCount} 条被引用</span>
          ) : null}
          {expanded ? (
            <ChevronUp size={14} className="cites-header-chevron" aria-hidden />
          ) : (
            <ChevronDown
              size={14}
              className="cites-header-chevron"
              aria-hidden
            />
          )}
        </button>
      ) : (
        <div className="cites-header">
          <Globe size={14} className="cites-header-icon" aria-hidden />
          <span>{`来源 ${items.length}`}</span>
          {hasRefs ? (
            <span className="cites-header-meta">· {citedCount} 条被引用</span>
          ) : null}
        </div>
      )}

      {expanded ? (
        <div>
          <div className="cites-list">
            {rows.map(({ poolIndex, display, cited }) => {
              const c = items[poolIndex];
              if (!c) return null;
              const title = cleanSourceTitle(c.title) || c.site || c.url;
              return (
                <a
                  key={`${c.url}-${display}`}
                  className={`cites-row ${dimClass(cited) ?? ""}`.trim()}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`来源 ${display}：${title}`}
                >
                  <span className="cites-n">{display}</span>
                  <Favicon site={c.site} title={c.title} size={18} />
                  <span className="cites-body">
                    <span className="cites-title-row">
                      <span className="cites-title">{title}</span>
                      <CitationTierBadge tier={c.tier} />
                    </span>
                    {c.site ? (
                      <span className="cites-site">{c.site}</span>
                    ) : null}
                    {c.snippet ? (
                      <span className="cites-snippet">{c.snippet}</span>
                    ) : null}
                    {c.id ? (
                      <span className="cites-id" title={`台账 ${c.id}`}>
                        {c.id}
                      </span>
                    ) : null}
                  </span>
                </a>
              );
            })}
          </div>
          {hidden > 0 ? (
            <button
              type="button"
              className="cites-collapse"
              onClick={() => setExpanded(false)}
            >
              <ChevronUp size={14} aria-hidden />
              收起
            </button>
          ) : null}
        </div>
      ) : (
        <div className="cites-pills">
          {collapsed.map(({ poolIndex, display, cited }) => {
            const c = items[poolIndex];
            if (!c) return null;
            const title = cleanSourceTitle(c.title) || c.site || c.url;
            return (
              <a
                key={`${c.url}-${display}`}
                className={`cites-pill ${dimClass(cited) ?? ""}`.trim()}
                href={c.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`来源 ${display}：${title}`}
              >
                <span className="cites-pill-n">{display}</span>
                <Favicon site={c.site} title={c.title} size={16} />
                <span className="cites-pill-site">{c.site || c.url}</span>
                <CitationTierBadge tier={c.tier} />
              </a>
            );
          })}
          {hidden > 0 ? (
            <button
              type="button"
              className="cites-pill cites-pill-more"
              onClick={() => setExpanded(true)}
            >
              <span className="cites-stack">
                {stack.map(({ poolIndex, display }) => {
                  const c = items[poolIndex];
                  if (!c) return null;
                  return (
                    <Favicon
                      key={`${c.url}-stack-${display}`}
                      site={c.site}
                      title={c.title}
                      size={16}
                      className="cites-stack-icon"
                    />
                  );
                })}
              </span>
              <span className="cites-pill-n">+{hidden}</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
