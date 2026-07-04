/** 画布放大态 per-conversation 侧面板偏好（开/关 + 落在哪个 tab）。 */

import type { EndpointKind } from "@/stores/sidePanel";
import {
  DEBATE_HUD_TAB_ID,
  WORKSPACE_TAB_ID,
  useSidePanelStore,
} from "@/stores/sidePanel";

const STORAGE_KEY = "agentcore:canvas-zoom-panel";

/** Semantic surface while the canvas is zoomed into a turn — survives remount / reload. */
export type CanvasZoomPanelSurface =
  | { kind: "closed" }
  | { kind: "workspace" }
  | { kind: "debate-hud" }
  | { kind: "run"; messageId: string; runId: string; title: string }
  | {
      kind: "content";
      messageId: string;
      contentMessageId: string;
      title: string;
      endpoint: EndpointKind;
    };

function loadAll(): Record<string, CanvasZoomPanelSurface> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, CanvasZoomPanelSurface> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const surface = parseSurface(v);
      if (surface) out[k] = surface;
    }
    return out;
  } catch {
    return {};
  }
}

function parseSurface(v: unknown): CanvasZoomPanelSurface | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (kind === "closed") return { kind: "closed" };
  if (kind === "workspace") return { kind: "workspace" };
  if (kind === "debate-hud") return { kind: "debate-hud" };
  if (
    kind === "run" &&
    typeof o.messageId === "string" &&
    typeof o.runId === "string" &&
    typeof o.title === "string"
  ) {
    return {
      kind: "run",
      messageId: o.messageId,
      runId: o.runId,
      title: o.title,
    };
  }
  if (
    kind === "content" &&
    typeof o.messageId === "string" &&
    typeof o.contentMessageId === "string" &&
    typeof o.title === "string" &&
    (o.endpoint === "prompt" || o.endpoint === "answer")
  ) {
    return {
      kind: "content",
      messageId: o.messageId,
      contentMessageId: o.contentMessageId,
      title: o.title,
      endpoint: o.endpoint,
    };
  }
  return null;
}

function saveAll(prefs: Record<string, CanvasZoomPanelSurface>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* unavailable — session-only */
  }
}

export function loadCanvasZoomPanelPref(
  conversationId: string,
): CanvasZoomPanelSurface | null {
  return loadAll()[conversationId] ?? null;
}

export function persistCanvasZoomPanelPref(
  conversationId: string,
  surface: CanvasZoomPanelSurface,
): void {
  const all = loadAll();
  all[conversationId] = surface;
  saveAll(all);
}

/** Snapshot the live side panel into a restorable surface. */
export function captureCanvasZoomPanelPref(): CanvasZoomPanelSurface {
  const s = useSidePanelStore.getState();
  if (!s.open) return { kind: "closed" };
  if (s.activeTabId === WORKSPACE_TAB_ID) return { kind: "workspace" };
  if (s.activeTabId === DEBATE_HUD_TAB_ID) return { kind: "debate-hud" };
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab) return { kind: "closed" };
  if (tab.kind === "run") {
    return {
      kind: "run",
      messageId: tab.messageId,
      runId: tab.runId,
      title: tab.title,
    };
  }
  return {
    kind: "content",
    messageId: tab.messageId,
    contentMessageId: tab.contentMessageId,
    title: tab.title,
    endpoint: tab.endpoint,
  };
}

/** Re-open the panel to a previously saved surface (detail tabs are recreated). */
export function applyCanvasZoomPanelPref(surface: CanvasZoomPanelSurface): void {
  const store = useSidePanelStore.getState();
  switch (surface.kind) {
    case "closed":
      store.closePanel();
      break;
    case "workspace":
      store.showWorkspace();
      break;
    case "debate-hud":
      store.showDebateHudTab();
      break;
    case "run":
      store.showRunDetail(surface.messageId, surface.runId, surface.title);
      break;
    case "content":
      store.showContentDetail(
        surface.messageId,
        surface.contentMessageId,
        surface.title,
        surface.endpoint,
      );
      break;
  }
}

/** First zoom into this conversation with no saved pref — avoid landing on 工作区. */
export function defaultCanvasZoomPanelPref(opts: {
  showRoom: boolean;
  scopeId: string;
  finalAnswerId: string | null;
}): CanvasZoomPanelSurface {
  if (opts.showRoom) return { kind: "debate-hud" };
  if (opts.finalAnswerId) {
    return {
      kind: "content",
      messageId: opts.scopeId,
      contentMessageId: opts.finalAnswerId,
      title: "最终回答",
      endpoint: "answer",
    };
  }
  return { kind: "closed" };
}
