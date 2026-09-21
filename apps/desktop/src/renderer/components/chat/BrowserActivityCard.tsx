import { IconButton } from "@/components/ui";
import { isBrowserTool } from "@/lib/browserActivity";
import { fetchWorkspaceFileBlob } from "@/services/workspace";
import { useBrowserSessionsStore } from "@/stores/browserSessions";
import { useStreamAwareDisclosure } from "@/stores/disclosure";
import type { BrowserDisplay, ProcessStep } from "@/types/events";
import {
  ChevronDown,
  ChevronRight,
  Globe,
  ImageOff,
  type LucideIcon,
  Monitor,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  LiveFlow,
  LiveFlowDots,
  LiveFlowText,
} from "./message-bubble/LiveFlow";
import { toolMeta } from "./message-bubble/constants";
import { toolGroupFaultLabel } from "./toolResult/toolFaultFace";

type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

/** A single browser step's action-verb chrome. Reuses {@link toolMeta} (`browser` +
 * `args.action`) so the per-step verb and the tool row stay in sync; an unknown
 * (newer-backend) verb degrades to a Globe + a Title-cased label. */
function browserActionMeta(action: string): {
  Icon: LucideIcon;
  label: string;
} {
  if (!action) return { Icon: Globe, label: "Step" };
  return toolMeta("browser", { action });
}

/** True when a tool-group is ≥2 consecutive browser steps → render as one activity card
 * (mirrors {@link isWebFetchSourceGroup}). A single browser step stays a normal ToolLine. */
export function isBrowserActivityGroup(tools: ToolStep[]): boolean {
  return tools.length >= 2 && tools.every((t) => isBrowserTool(t.tool_name));
}

/** Narrow a tool step's opaque `display` to a {@link BrowserDisplay} (the DURABLE card
 * data — never sourced from the live-only tool_use_progress). */
export function isBrowserDisplay(d: unknown): d is BrowserDisplay {
  if (!d) return false;
  const x = d as { kind?: unknown; action?: unknown; url?: unknown };
  return (
    x.kind === "browser" &&
    typeof x.action === "string" &&
    typeof x.url === "string"
  );
}

interface BrowserStepView {
  id: string;
  action: string;
  status: ToolStep["status"];
  url: string;
  title?: string;
  frame?: string;
}

/** Verb for a live (no-display) browser step: `display.action` / `args.action` first.
 * Historical `browser_<action>` names fall back to the suffix; never `slice` the
 * unified name `"browser"` (that would yield an empty verb, not an action). */
function browserStepAction(t: ToolStep): string {
  if (isBrowserDisplay(t.display)) return t.display.action;
  const fromArgs =
    typeof t.arguments.action === "string" ? t.arguments.action.trim() : "";
  if (fromArgs) return fromArgs;
  if (t.tool_name.startsWith("browser_")) {
    return t.tool_name.slice("browser_".length);
  }
  return "";
}

/** Build the card's step models FROM each step's durable `display` (so a reload /
 * journal replay rebuilds the card verbatim). A step with no display yet (live, before
 * its tool_use_end) keeps a slot derived from the call — the verb from `display.action`
 * / `args.action` (historical `browser_*` suffix as last resort) and the url from the
 * call arg — so the list doesn't jump when the display lands. */
function browserStepsFromTools(tools: ToolStep[]): BrowserStepView[] {
  return tools.map((t) => {
    if (isBrowserDisplay(t.display)) {
      return {
        id: t.id,
        action: t.display.action,
        status: t.status,
        url: t.display.url,
        title: t.display.title,
        frame: t.display.frame,
      };
    }
    const action = browserStepAction(t);
    const url = typeof t.arguments.url === "string" ? t.arguments.url : "";
    return { id: t.id, action, status: t.status, url };
  });
}

/** A one-line human label for a frame (lightbox caption / img alt). Identity, not action restatement. */
function frameAlt(step: {
  action: string;
  title?: string;
  url?: string;
}): string {
  const title = step.title?.trim() ?? "";
  if (title) return title;
  const { label } = browserActionMeta(step.action);
  return step.url ? `${label} · ${step.url}` : label;
}

/**
 * Lazily fetch a conversation-workspace key-frame as an object URL (only mounts once the
 * card / row is expanded, so the jpeg is pulled on-demand — no thumbnail endpoint, the
 * original is fetched directly). Mirrors the IM ChatImageAttachment blob + objectURL +
 * revoke-on-unmount pattern. Returns `failed` when there is no frame or the fetch errored.
 */
function useWorkspaceFrame(
  conversationId: string | null,
  frame: string | undefined,
): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!conversationId || !frame) {
      setFailed(true);
      setUrl(null);
      return;
    }
    setFailed(false);
    let active = true;
    let objectUrl: string | null = null;
    fetchWorkspaceFileBlob(conversationId, frame)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, frame]);

  return { url, failed };
}

/** Compact key-frame thumbnail for a step row — click opens the full frame in a lightbox. */
function BrowserThumb({
  conversationId,
  frame,
  alt,
  onOpen,
}: {
  conversationId: string | null;
  frame: string;
  alt: string;
  onOpen: (src: string, alt: string) => void;
}) {
  const { url, failed } = useWorkspaceFrame(conversationId, frame);
  if (failed) {
    return (
      <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
        <ImageOff size={16} />
      </div>
    );
  }
  if (!url) {
    return (
      <div className="h-16 w-28 shrink-0 animate-pulse rounded-lg bg-muted" />
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(url, alt)}
      className="h-16 w-28 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-ring"
      title={alt}
    >
      <img src={url} alt={alt} className="h-full w-full object-cover" />
    </button>
  );
}

/** Placeholder box for a step with no key-frame — keeps rows aligned with the action icon. */
function BrowserThumbPlaceholder({ Icon }: { Icon: LucideIcon }) {
  return (
    <div
      className="flex h-16 w-28 shrink-0 items-center justify-center rounded-lg border border-border border-dashed bg-muted/30 text-muted-foreground/60"
      aria-hidden
    >
      <Icon size={18} />
    </div>
  );
}

/** Full-resolution key-frame for a single-step browser result — click opens the lightbox. */
function BrowserResultFrame({
  conversationId,
  frame,
  alt,
  onOpen,
}: {
  conversationId: string | null;
  frame: string;
  alt: string;
  onOpen: (src: string, alt: string) => void;
}) {
  const { url, failed } = useWorkspaceFrame(conversationId, frame);
  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
        <ImageOff size={20} />
      </div>
    );
  }
  if (!url) {
    return <div className="h-40 w-full animate-pulse rounded-lg bg-muted" />;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(url, alt)}
      className="block w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-ring"
      title={alt}
    >
      <img
        src={url}
        alt={alt}
        className="mx-auto max-h-80 w-auto object-contain"
      />
    </button>
  );
}

/** Fullscreen key-frame viewer (lightbox). Close via the X button, Esc, or clicking the
 * backdrop — no zoom/pan (M0 keeps it minimal; a screenshot is already 1:1). */
function BrowserFrameLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: a lightweight image lightbox overlay — role="dialog" + Esc/backdrop close is enough; a native <dialog> would add modal/form semantics we don't need.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "浏览器关键帧"}
      className="fixed inset-0 z-50 flex flex-col bg-background/95"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-border border-b px-4">
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {alt}
        </span>
        <IconButton onClick={onClose} aria-label="关闭" title="关闭">
          <X size={16} />
        </IconButton>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center overflow-auto p-6"
      >
        <img
          src={src}
          alt={alt}
          className="max-h-full max-w-full object-contain"
        />
      </button>
    </div>,
    document.body,
  );
}

/** One step row inside the activity card: key-frame thumbnail + action + one subline. */
function BrowserStepRow({
  step,
  index,
  conversationId,
  onOpenFrame,
}: {
  step: BrowserStepView;
  index: number;
  conversationId: string | null;
  onOpenFrame: (src: string, alt: string) => void;
}) {
  const { Icon, label } = browserActionMeta(step.action);
  const alt = frameAlt(step);
  const subline = browserSubline(step.title, step.url);
  return (
    <LiveFlow
      active={step.status === "running"}
      className="flex items-start gap-3 rounded-lg px-2 py-2"
    >
      {step.frame ? (
        <BrowserThumb
          conversationId={conversationId}
          frame={step.frame}
          alt={alt}
          onOpen={onOpenFrame}
        />
      ) : (
        <BrowserThumbPlaceholder Icon={Icon} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <Icon size={14} className="shrink-0 text-muted-foreground" />
          <span className="font-medium text-foreground">
            <LiveFlowText>{label}</LiveFlowText>
          </span>
          {step.status === "running" && <LiveFlowDots active />}
          {step.status === "error" && (
            <X size={13} className="shrink-0 text-destructive" />
          )}
        </div>
        {subline ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {subline}
          </p>
        ) : null}
      </div>
    </LiveFlow>
  );
}

/**
 * Merged view for a tool-group of ≥2 consecutive `browser_*` steps — the browser activity
 * card. Collapses to a bare「浏览器 · N 步」header (aligned with the web_fetch source
 * collection / tool-group chrome); expands into a step list (action + one subline) with
 * lazy key-frame thumbnails, each opening the full frame in a lightbox.
 * Card data comes ONLY from each step's durable `display`, so it rebuilds on journal replay.
 * Reuses WebFetchSourceCollection's `${turnKey}:tgrp:${groupKey}` disclosure key.
 */
export function BrowserActivityCard({
  tools,
  isStreaming,
  turnKey,
  groupKey,
  conversationId,
}: {
  tools: ToolStep[];
  isStreaming: boolean;
  turnKey?: string;
  groupKey?: string;
  conversationId: string | null;
}) {
  const [expanded, toggleExpanded] = useStreamAwareDisclosure(
    turnKey != null && groupKey != null ? `${turnKey}:tgrp:${groupKey}` : null,
    isStreaming,
  );
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const openFrame = useCallback(
    (src: string, alt: string) => setLightbox({ src, alt }),
    [],
  );

  const steps = browserStepsFromTools(tools);
  const running = tools.some((t) => t.status === "running");
  const groupFault = !expanded ? toolGroupFaultLabel(tools) : null;
  const count = steps.length;
  const title = `浏览器 · ${count} 步`;

  // browser_* 步进出现/结束 → 预 hydrate，打开坞时对齐 server session 页。
  const hydrateKey = tools.map((t) => `${t.id}:${t.status}`).join("|");
  useEffect(() => {
    if (!conversationId || !hydrateKey) return;
    void useBrowserSessionsStore.getState().hydrateConversation(conversationId);
  }, [conversationId, hydrateKey]);

  const headerLive = running && !expanded;

  return (
    <div>
      <LiveFlow active={headerLive} className="mb-2 min-w-0 w-full">
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="flex min-w-0 w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <Monitor size={14} className="shrink-0" />
          {headerLive && <LiveFlowDots active />}
          <LiveFlowText className="min-w-0 truncate text-left">
            {title}
          </LiveFlowText>
          {groupFault && (
            <span
              data-testid="tool-group-fault"
              className="shrink-0 text-xs text-muted-foreground/70"
            >
              {groupFault}
            </span>
          )}
          {expanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
        </button>
      </LiveFlow>

      {expanded && (
        <div className="flex max-h-[28rem] flex-col gap-0.5 overflow-y-auto pr-1">
          {steps.map((s, i) => (
            <BrowserStepRow
              key={s.id}
              step={s}
              index={i}
              conversationId={conversationId}
              onOpenFrame={openFrame}
            />
          ))}
        </div>
      )}

      {lightbox && (
        <BrowserFrameLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

/**
 * Single browser step expanded body: leftover facts the title line did not
 * carry (destination URL when the chip is the page title) plus the key-frame.
 * No second Navigate header; 打开浏览器 stays on the dock tab / `+`.
 * ≥2 consecutive steps → {@link BrowserActivityCard}.
 */
export function BrowserResult({
  display,
  conversationId,
}: {
  display: BrowserDisplay;
  conversationId: string | null;
}) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const alt = frameAlt(display);
  const extras = browserExpandExtras(display);
  const frame = display.frame?.trim() ?? "";
  if (!frame && !extras) return null;

  return (
    <div className="mt-1">
      {extras ? (
        <p className="truncate text-xs text-muted-foreground">{extras}</p>
      ) : null}
      {frame ? (
        <div
          className={`overflow-hidden rounded-lg border border-border bg-muted/30 p-2 ${
            extras ? "mt-1" : ""
          }`}
        >
          <BrowserResultFrame
            conversationId={conversationId}
            frame={frame}
            alt={alt}
            onOpen={(src, a) => setLightbox({ src, alt: a })}
          />
        </div>
      ) : null}
      {lightbox && (
        <BrowserFrameLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

/** Expanded-card subline: page identity. Title + url when they are distinct;
 * never action restatement / ref / snapshot version. */
export function browserSubline(title?: string, url?: string): string {
  const t = title?.trim() ?? "";
  const u = url?.trim() ?? "";
  if (t && u && t.includes(u)) return t;
  if (t && u) return `${t} · ${u}`;
  return t || u;
}

/** Collapsed ToolLine chip for one browser step: page title, else url.
 * Action restatement (读取页面结构 / 截取当前页面 / 点击元素 ref) stays off the row. */
export function browserResultTail(display: BrowserDisplay): string {
  const title = display.title?.trim() ?? "";
  const url = display.url?.trim() ?? "";
  return title || url;
}

/** True when `tail` already names `url` (trailing-slash variants count as the same). */
function tailHasUrl(tail: string, url: string): boolean {
  if (!url) return true;
  if (tail.includes(url)) return true;
  const stripped = url.replace(/\/+$/, "");
  return stripped.length > 0 && tail.includes(stripped);
}

/** Expand-body facts the title chip did not already carry — typically the URL
 * once Navigate shows the page title. Empty when the title is already the url
 * and there is nothing else to disclose. */
export function browserExpandExtras(display: BrowserDisplay): string {
  const url = display.url?.trim() ?? "";
  if (!url) return "";
  if (tailHasUrl(browserResultTail(display), url)) return "";
  return url;
}

export function browserHasExpandBody(display: BrowserDisplay): boolean {
  return (
    Boolean(display.frame?.trim()) || Boolean(browserExpandExtras(display))
  );
}

/** A compact one-line label for a frame / leftover peek (title row uses {@link browserResultTail}). */
export function browserResultPeek(display: BrowserDisplay): string {
  const { label } = browserActionMeta(display.action);
  const tail = browserResultTail(display);
  const line = tail ? `${label} · ${tail}` : label;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}
