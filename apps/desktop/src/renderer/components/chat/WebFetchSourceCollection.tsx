import { Button } from "@/components/ui";
import { useStreamAwareDisclosure } from "@/stores/disclosure";
import type { Citation, ProcessStep, WebFetchDisplay } from "@/types/events";
import { ChevronDown, ChevronRight, Globe } from "lucide-react";
import { SourceHitRow } from "./SourceHitRow";
import {
  LiveFlow,
  LiveFlowDots,
  LiveFlowText,
} from "./message-bubble/LiveFlow";

type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

function isWebFetchDisplay(d: unknown): d is WebFetchDisplay {
  if (!d) return false;
  const x = d as { url?: unknown; content?: unknown };
  return typeof x.url === "string" && typeof x.content === "string";
}

/** Aggregate source rows from each web_fetch step's display (never parse result JSON). */
function sourcesFromTools(tools: ToolStep[]): Citation[] {
  const out: Citation[] = [];
  for (const t of tools) {
    if (isWebFetchDisplay(t.display)) {
      out.push({
        url: t.display.url,
        title: t.display.title,
        site: t.display.site,
        snippet: t.display.snippet,
      });
      continue;
    }
    // Still running / no display yet — keep a slot from the call arg so the expanded list doesn't jump.
    const url =
      typeof t.arguments.url === "string" ? t.arguments.url.trim() : "";
    if (url) out.push({ url, title: "" });
  }
  return out;
}

/**
 * Merged view for a tool-group of ≥2 consecutive `web_fetch` calls: collapses to a bare
 *「Read page · N sources」header row (对齐工具组 / 思考过程的折叠态——折叠即收起细节，不再
 * 平铺来源 pills), expands into the same hit rows as search (index · favicon ·
 * title · domain, snippet below). Page body stays on the single-`web_fetch`
 * card. Folded header is title-only — fetch misses do not hang「未找到」
 * (the row already says N sources; user does not retry the fetch). Replaces
 * ToolLineGroup's chevron so there is only one disclosure layer;
 * persistence reuses the same `${turnKey}:tgrp:${groupKey}` key.
 */
export function WebFetchSourceCollection({
  tools,
  isStreaming,
  turnKey,
  groupKey,
}: {
  tools: ToolStep[];
  isStreaming: boolean;
  turnKey?: string;
  groupKey?: string;
}) {
  const [expanded, toggleExpanded] = useStreamAwareDisclosure(
    turnKey != null && groupKey != null ? `${turnKey}:tgrp:${groupKey}` : null,
    isStreaming,
  );

  const citations = sourcesFromTools(tools);
  const running = tools.some((t) => t.status === "running");
  const count = tools.length;
  const title = `Read page · ${count} source${count === 1 ? "" : "s"}`;

  return (
    <div>
      <LiveFlow active={running} className="mb-1.5 w-full">
        <Button
          variant="ghost"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="h-auto w-full justify-start gap-1.5 px-0 py-0 text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          <span className="flex items-center gap-1.5">
            <Globe size={14} className="shrink-0" />
            {running && <LiveFlowDots active />}
            <LiveFlowText className="min-w-0 truncate text-left">
              {title}
            </LiveFlowText>
            {expanded ? (
              <ChevronDown size={14} className="shrink-0" />
            ) : (
              <ChevronRight size={14} className="shrink-0" />
            )}
          </span>
        </Button>
      </LiveFlow>

      {expanded && (
        <div className="flex max-h-96 flex-col gap-0.5 overflow-y-auto pr-1">
          {citations.map((c, i) => (
            <SourceHitRow
              key={`${c.url}-${i}`}
              index={i + 1}
              url={c.url}
              title={c.title}
              site={c.site}
              snippet={c.snippet}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** True when a tool-group should render as a merged source collection. */
export function isWebFetchSourceGroup(tools: ToolStep[]): boolean {
  return tools.length >= 2 && tools.every((t) => t.tool_name === "web_fetch");
}
