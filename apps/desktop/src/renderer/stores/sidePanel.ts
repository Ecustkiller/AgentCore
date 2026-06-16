import { create } from "zustand";

/**
 * Unified conversation side panel (前端UX设计.md §十) — the chat's single
 * right-docked surface, modelled as ONE flat tab strip:
 *
 *  - a fixed, non-closable 「工作区」 home tab (the cloud↔local mode bar + the
 *    files body, with 快照 / 交接 as on-demand overlays), always first;
 *  - a closable run-detail tab for each inline-graph node the user drills into.
 *
 * There is no separate "detail mode" — the run tabs ARE the detail, so the panel
 * never shows an empty detail placeholder. `open` / `width` are persisted; the run
 * tabs are session-level (rebuilt from the execution slot).
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

/**
 * A run-detail tab — one per drilled-into run. Clicking an inline graph node
 * pins that run here (前端UX设计.md §十). Scoped by message so two turns that
 * each pin a run never collide in the strip (§9.3).
 */
export interface DetailTab {
  /** Dedup identity: `run-detail:<messageId>:<runId>`. */
  id: string;
  /** Label shown in the tab strip (the agent's role). */
  title: string;
  /** The assistant message whose execution slot holds this run. */
  messageId: string;
  /** The run this tab drills into. */
  runId: string;
}

export const runDetailTabId = (messageId: string, runId: string): string =>
  `run-detail:${messageId}:${runId}`;

interface SidePanelState {
  /** Panel visibility (persisted). */
  open: boolean;
  /** Docked width in px, clamped to [280, 560] (persisted). */
  width: number;
  /** Open run-detail tabs, left→right (session-level; stale tabs are filtered at
   * render against the live projection). The 工作区 home tab is implicit and is
   * NOT part of this array. */
  tabs: DetailTab[];
  /** Active tab: `WORKSPACE_TAB_ID` for the home tab, otherwise a run tab id.
   * Defaults to the workspace home so a manual open lands on the project files. */
  activeTabId: string;

  /** Open (or re-focus) a run-detail tab, deduped by id; reveals + activates it. */
  openTab: (tab: DetailTab, opts?: { activate?: boolean }) => void;
  /** Close a run tab; falls back to a neighbour run tab, else the 工作区 home.
   * Never closes the panel (the home tab is always there). */
  closeTab: (id: string) => void;
  /** Activate a tab (`WORKSPACE_TAB_ID` or a run tab id). */
  setActiveTab: (id: string) => void;
  /**
   * Pin a run (of a specific message's turn) and reveal it. The inline graph
   * highlights whatever run tab is active for that turn, so opening / switching
   * / closing tabs keeps the graph in sync (§9.3).
   */
  showRunDetail: (messageId: string, runId: string, title?: string) => void;
  /** Reveal the panel on the 工作区 home tab (the chat toggle / Ctrl+J). */
  showWorkspace: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setWidth: (width: number) => void;
}

export const useSidePanelStore = create<SidePanelState>((set, get) => ({
  open: loadOpen(),
  width: loadWidth(),
  tabs: [],
  // Run tabs are session-level (rebuilt from the execution slot), so a fresh
  // load always starts on the workspace home rather than a dangling run id.
  activeTabId: WORKSPACE_TAB_ID,

  openTab: (tab, opts) => {
    persist(OPEN_KEY, "true");
    set((s) => {
      const exists = s.tabs.some((t) => t.id === tab.id);
      let tabs = exists
        ? s.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
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
        // Fall back to the neighbour run tab (next, else previous), else home.
        const next = tabs[idx] ?? tabs[idx - 1] ?? null;
        activeTabId = next ? next.id : WORKSPACE_TAB_ID;
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  showRunDetail: (messageId, runId, title) => {
    get().openTab({
      id: runDetailTabId(messageId, runId),
      title: title ?? "详情",
      messageId,
      runId,
    });
  },

  showWorkspace: () => {
    persist(OPEN_KEY, "true");
    set({ open: true, activeTabId: WORKSPACE_TAB_ID });
  },

  closePanel: () => {
    persist(OPEN_KEY, "false");
    set({ open: false });
  },

  togglePanel: () => {
    const next = !get().open;
    persist(OPEN_KEY, String(next));
    set({ open: next });
  },

  setWidth: (width) => {
    const clamped = clampWidth(width);
    persist(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },
}));
