import { create } from "zustand";
import { useCommandPanelStore } from "./commandPanel";
import { useConversationStore } from "./conversation";

/**
 * Unified conversation side panel (前端UX设计.md §十) — the chat's single
 * right-docked surface, modelled as ONE flat tab strip:
 *
 *  - a fixed, non-closable 「工作区」 home tab (the cloud↔local mode bar + the
 *    files body, with 快照 / 交接 as on-demand overlays), always first;
 *  - in canvas mode only: a fixed, non-closable 「指挥台」 tab (boss decisions /
 *    救火 / 后台云端任务), always second — not a closable run/content detail;
 *  - a closable detail tab per drill: a run-detail tab for each inline-graph
 *    worker node, a content tab for an endpoint bubble (提问 / 最终回答), or a
 *    simple-turn Q&A tab for a canvas SimpleTurn light card (前端UX设计.md §五/§六).
 *
 * There is no separate "detail mode" — the detail tabs ARE the detail, so the panel
 * never shows an empty detail placeholder. `open` / `width` are persisted; the detail
 * tabs are session-level (rebuilt from the execution slot / live messages).
 */

/** Resize bounds for the panel. */
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 400;

/** Cap on run-detail tabs: opening a 7th drops the oldest (工作区 is exempt). */
const MAX_TABS = 6;

const OPEN_KEY = "agentcore:side-panel-open";
const WIDTH_KEY = "agentcore:side-panel-width";

export const SIDE_PANEL_MIN_WIDTH = MIN_WIDTH;
export const SIDE_PANEL_MAX_WIDTH = MAX_WIDTH;
export const SIDE_PANEL_MAX_TABS = MAX_TABS;

/** Reserved id of the fixed 「工作区」 home tab (always first, never closes). */
export const WORKSPACE_TAB_ID = "workspace";

/** Reserved id of the fixed 「指挥台」 tab (canvas mode only; always second, never closes). */
export const COMMAND_TAB_ID = "command";

/** After the last closable detail tab closes → 工作区。 */
function homeTabAfterDetailClose(): string {
  return WORKSPACE_TAB_ID;
}

const clampWidth = (w: number): number =>
  Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

// localStorage access is wrapped because it throws in private-mode / non-DOM
// (test) contexts; a failed read falls back to the default, a failed write keeps
// the value in memory for the session.
function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampWidth(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* unavailable — session-only */
  }
}

/** Record dismiss for whichever auto-surface context is currently active. */
function recordActiveContextDismiss(
  get: () => Pick<SidePanelState, "dismissAutoSurface">,
): void {
  const commandActive = useCommandPanelStore.getState().active;
  const conversationId = useConversationStore.getState().currentConversationId;
  if (commandActive && conversationId) {
    get().dismissAutoSurface(`command:${conversationId}`);
  }
}

/**
 * A run-detail tab — one per drilled-into run. Clicking an inline graph node
 * pins that run here (前端UX设计.md §十). Scoped by message so two turns that
 * each pin a run never collide in the strip (§9.3).
 */
export interface RunDetailTab {
  /** Discriminator: a worker run's structured detail (RunDetailBody). */
  kind: "run";
  /** Dedup identity: `run-detail:<messageId>:<runId>`. */
  id: string;
  /** Label shown in the tab strip (the agent's role). */
  title: string;
  /** The assistant message whose execution slot holds this run. */
  messageId: string;
  /** The run this tab drills into. */
  runId: string;
}

/**
 * A content tab — the turn's endpoint chat bubble (the user's prompt or the CEO's
 * final answer) surfaced in the docked panel. The canvas (放大态 / 聚焦节点) has no
 * chat column alongside, so an endpoint reads here — like a worker drill — instead
 * of a foot drawer (前端UX设计.md §五/§六). Endpoints are bubbles, not runs, so they
 * ride this kind rather than RunDetailBody. Scoped by the turn (`messageId`) so it
 * lights that graph's endpoint node; `contentMessageId` is the bubble rendered.
 */
/** Which endpoint a content tab stands for — drives its tab-strip icon (提问 vs
 * 最终回答), mirroring the graph endpoint nodes (用户输入 / CEO 汇聚点). */
export type EndpointKind = "prompt" | "answer";

export interface ContentDetailTab {
  /** Discriminator: a chat bubble rendered as Markdown (no run). */
  kind: "content";
  /** Dedup identity: `content-detail:<messageId>:<contentMessageId>`. */
  id: string;
  /** Label shown in the tab strip (提问 / 最终回答). */
  title: string;
  /** The turn (assistant message owning the execution) this endpoint belongs to. */
  messageId: string;
  /** The chat message whose content is rendered (the prompt / the final answer). */
  contentMessageId: string;
  /** The endpoint this bubble stands for — the user's prompt / the CEO's answer. */
  endpoint: EndpointKind;
}

/**
 * A simple-turn Q&A tab — the whole CEO-only exchange (user prompt + assistant
 * answer) from a canvas `SimpleTurn` light card. Pure dialogue has no execution
 * plan, so it must not ride `content` (whose live check requires a plan) or
 * `run` (前端UX设计.md §6.1 / §十).
 */
export interface SimpleTurnDetailTab {
  /** Discriminator: full Q&A for a no-execution turn. */
  kind: "simple-turn";
  /** Dedup identity: `simple-turn:<messageId>`. */
  id: string;
  /** Label shown in the tab strip (对话). */
  title: string;
  /** The turn key (assistant projection id) this Q&A belongs to. */
  messageId: string;
  /** The user message bubble rendered under 「提问」. */
  promptMessageId: string;
  /** The assistant message bubble rendered under 「回答」. */
  answerMessageId: string;
}

/** A side-panel detail tab: a worker run, an endpoint bubble, or a simple-turn Q&A. */
export type DetailTab = RunDetailTab | ContentDetailTab | SimpleTurnDetailTab;

export const runDetailTabId = (messageId: string, runId: string): string =>
  `run-detail:${messageId}:${runId}`;

export const contentDetailTabId = (
  messageId: string,
  contentMessageId: string,
): string => `content-detail:${messageId}:${contentMessageId}`;

export const simpleTurnDetailTabId = (messageId: string): string =>
  `simple-turn:${messageId}`;

interface SidePanelState {
  /** Panel visibility (persisted). */
  open: boolean;
  /** Docked width in px, clamped to [280, 560] (persisted). */
  width: number;
  /** Open detail tabs (run / content / simple-turn), left→right (session-level;
   * stale run/content tabs are filtered at render against the live projection;
   * simple-turn tabs stay live without a plan). The 工作区 home tab is implicit
   * and is NOT part of this array. */
  tabs: DetailTab[];
  /** Active tab: `WORKSPACE_TAB_ID` / `COMMAND_TAB_ID` for fixed tabs, else a detail
   * tab id. Defaults to the workspace home so a manual open lands on the project files. */
  activeTabId: string;
  /**
   * A file the chat asked to preview (clicking a 产出文件 card row): the workspace
   * file browser watches this, opens the path in its swap-style preview, then
   * clears it. `nonce` lets the same path re-fire (re-click). Session-only.
   */
  pendingFilePreview: { path: string; name: string; nonce: number } | null;
  /**
   * Session-level memory of contexts where the user explicitly closed the panel,
   * blocking auto-surface until the panel is opened again or the context clears.
   */
  dismissedContexts: Set<string>;
  /**
   * Count of auto-surface events suppressed while the panel was dismissed — shown
   * as a badge on the panel toggle when the dock is closed.
   */
  pendingBadge: number;

  /** Record that auto-surface should not reopen the panel for this context. */
  dismissAutoSurface: (contextId: string) => void;
  isAutoSurfaceDismissed: (contextId: string) => boolean;
  clearAutoSurfaceDismiss: (contextId: string) => void;
  /** Bump the toggle badge when auto-surface is blocked by a dismiss. */
  incrementPendingBadge: () => void;

  /** Open (or re-focus) a detail tab, deduped by id; reveals + activates it. */
  openTab: (tab: DetailTab, opts?: { activate?: boolean }) => void;
  /** Close a detail tab; falls back to a neighbour tab, else the 工作区 home.
   * Never closes the panel (the home tab is always there). */
  closeTab: (id: string) => void;
  /** Activate a tab (`WORKSPACE_TAB_ID` / `COMMAND_TAB_ID` or a detail tab id). */
  setActiveTab: (id: string) => void;
  /**
   * Pin a run (of a specific message's turn) and reveal it. The inline graph
   * highlights whatever run tab is active for that turn, so opening / switching
   * / closing tabs keeps the graph in sync (§9.3).
   */
  showRunDetail: (messageId: string, runId: string, title?: string) => void;
  /**
   * Pin an endpoint chat bubble (the turn's prompt / final answer) and reveal it.
   * The canvas surfaces an endpoint here (no chat column alongside); the inline
   * graph lights the matching endpoint node while its content tab is active.
   */
  showContentDetail: (
    messageId: string,
    contentMessageId: string,
    title: string,
    endpoint: EndpointKind,
  ) => void;
  /**
   * Pin a simple-turn Q&A (user prompt + assistant answer) and reveal it. Used by
   * canvas `SimpleTurn` light cards — no execution, so not a run/content tab.
   */
  showSimpleTurnDetail: (
    messageId: string,
    promptMessageId: string,
    answerMessageId: string,
    title?: string,
  ) => void;
  /**
   * Drop every reading-context tab (endpoint content + simple-turn Q&A), keeping
   * run tabs. The canvas calls this when leaving its reading context (放大态 exit /
   * canvas→chat) so a surfaced 提问 / 最终回答 / 对话 never lingers beside the chat
   * bubble that already shows it.
   */
  closeContentTabs: () => void;
  /**
   * Reveal the panel WITHOUT touching the active tab — used by the 指挥台 tab's
   * auto-surface (前端UX设计.md §6.2) so a newly-arrived decision opens the dock while
   * a run/workspace tab the user is reading stays put (only the 指挥台 tab badge updates).
   */
  openPanel: () => void;
  /** Reveal the panel on the 工作区 home tab (the chat toggle / Ctrl+J). */
  showWorkspace: () => void;
  /** Reveal the 工作区 home tab AND request a file preview (产出文件 card click). */
  showFile: (path: string, name: string) => void;
  /** Consume the pending file-preview request once the files view has applied it. */
  clearFilePreview: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setWidth: (width: number) => void;
}

export const useSidePanelStore = create<SidePanelState>((set, get) => ({
  open: loadOpen(),
  width: loadWidth(),
  tabs: [],
  // Detail tabs are session-level (rebuilt from the execution slot / live
  // messages), so a fresh load always starts on the workspace home rather than a
  // dangling tab id.
  activeTabId: WORKSPACE_TAB_ID,
  pendingFilePreview: null,
  dismissedContexts: new Set(),
  pendingBadge: 0,

  dismissAutoSurface: (contextId) => {
    set((s) => {
      const dismissedContexts = new Set(s.dismissedContexts);
      dismissedContexts.add(contextId);
      return { dismissedContexts };
    });
  },

  isAutoSurfaceDismissed: (contextId) => get().dismissedContexts.has(contextId),

  clearAutoSurfaceDismiss: (contextId) => {
    set((s) => {
      if (!s.dismissedContexts.has(contextId)) return s;
      const dismissedContexts = new Set(s.dismissedContexts);
      dismissedContexts.delete(contextId);
      return { dismissedContexts };
    });
  },

  incrementPendingBadge: () =>
    set((s) => ({ pendingBadge: s.pendingBadge + 1 })),

  openTab: (tab, opts) => {
    persist(OPEN_KEY, "true");
    set((s) => {
      const exists = s.tabs.some((t) => t.id === tab.id);
      // A re-open replaces the tab wholesale (same id ⇒ same kind, namespaced
      // prefixes guarantee it), refreshing its title/scope without merging kinds.
      let tabs = exists
        ? s.tabs.map((t) => (t.id === tab.id ? tab : t))
        : [...s.tabs, tab];
      // Cap the run-tab strip: a new tab beyond the limit pushes out the oldest.
      if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS);
      const activate = opts?.activate !== false;
      return {
        tabs,
        open: true,
        activeTabId: activate ? tab.id : s.activeTabId,
      };
    });
  },

  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) {
        // Fall back to the neighbour detail tab (next, else previous), else home.
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = next ? next.id : homeTabAfterDetailClose();
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  showRunDetail: (messageId, runId, title) => {
    get().openTab({
      kind: "run",
      id: runDetailTabId(messageId, runId),
      title: title ?? "详情",
      messageId,
      runId,
    });
  },

  showContentDetail: (messageId, contentMessageId, title, endpoint) => {
    get().openTab({
      kind: "content",
      id: contentDetailTabId(messageId, contentMessageId),
      title,
      messageId,
      contentMessageId,
      endpoint,
    });
  },

  showSimpleTurnDetail: (
    messageId,
    promptMessageId,
    answerMessageId,
    title,
  ) => {
    get().openTab({
      kind: "simple-turn",
      id: simpleTurnDetailTabId(messageId),
      title: title ?? "对话",
      messageId,
      promptMessageId,
      answerMessageId,
    });
  },

  closeContentTabs: () => {
    set((s) => {
      const tabs = s.tabs.filter(
        (t) => t.kind !== "content" && t.kind !== "simple-turn",
      );
      if (tabs.length === s.tabs.length) return s;
      // If the dropped tab was active, fall back to a surviving detail tab (e.g. a
      // run drilled in the canvas, kept per §十) else the 工作区 home.
      const activeStillThere = tabs.some((t) => t.id === s.activeTabId);
      const activeTabId = activeStillThere
        ? s.activeTabId
        : (tabs[tabs.length - 1]?.id ?? homeTabAfterDetailClose());
      return { tabs, activeTabId };
    });
  },

  openPanel: () => {
    persist(OPEN_KEY, "true");
    set({ open: true, pendingBadge: 0 });
  },

  showWorkspace: () => {
    persist(OPEN_KEY, "true");
    set({ open: true, activeTabId: WORKSPACE_TAB_ID, pendingBadge: 0 });
  },

  showFile: (path, name) => {
    persist(OPEN_KEY, "true");
    set((s) => ({
      open: true,
      activeTabId: WORKSPACE_TAB_ID,
      pendingFilePreview: {
        path,
        name,
        nonce: (s.pendingFilePreview?.nonce ?? 0) + 1,
      },
    }));
  },

  clearFilePreview: () => set({ pendingFilePreview: null }),

  closePanel: () => {
    persist(OPEN_KEY, "false");
    recordActiveContextDismiss(get);
    set({ open: false });
  },

  togglePanel: () => {
    const next = !get().open;
    persist(OPEN_KEY, String(next));
    if (!next) recordActiveContextDismiss(get);
    set({ open: next, pendingBadge: next ? 0 : get().pendingBadge });
  },

  setWidth: (width) => {
    const clamped = clampWidth(width);
    persist(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },
}));
