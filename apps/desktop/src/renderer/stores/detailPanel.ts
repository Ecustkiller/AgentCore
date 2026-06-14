import { create } from "zustand";
import { useExecutionStore } from "./execution";

/** Resize bounds for the conversation detail panel (see 前端UX目标态 §一). */
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 400;

/** Dynamic-tab cap: opening a 7th drops the oldest (see 前端UX目标态 §一). */
const MAX_TABS = 6;

const OPEN_KEY = "agentcore:detail-panel-open";
const WIDTH_KEY = "agentcore:detail-panel-width";

export const DETAIL_PANEL_MIN_WIDTH = MIN_WIDTH;
export const DETAIL_PANEL_MAX_WIDTH = MAX_WIDTH;
export const DETAIL_PANEL_MAX_TABS = MAX_TABS;

const clampWidth = (w: number): number =>
  Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

// localStorage access is wrapped because it throws in private-mode / non-DOM
// (test) contexts; a failed read just falls back to the default, a failed write
// keeps the value in memory for the session.
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
 * A run-detail tab — the only kind the panel holds. The panel is a passive
 * drill-down target: the inline collaboration graph is the team's primary
 * surface, and clicking one of its nodes pins that run here
 * (统一团队展示设计草案). The old progress / embedded-graph tabs are gone — that
 * job moved onto the inline graph itself.
 */
export interface DetailTab {
  /** Dedup identity: `run-detail:<runId>`. */
  id: string;
  /** Label shown in the tab strip (the agent's role). */
  title: string;
  /** The run this tab drills into. */
  runId: string;
}

export const runDetailTabId = (runId: string): string => `run-detail:${runId}`;

interface DetailPanelState {
  /** Panel visibility (persisted). */
  open: boolean;
  /** Docked width in px, clamped to [280, 560] (persisted). */
  width: number;
  /** Open run-detail tabs, left→right (session-level — bound to the current
   * execution; stale tabs are filtered at render against the live projection). */
  tabs: DetailTab[];
  /** Active tab id, or null when the panel holds no tabs. */
  activeTabId: string | null;

  /** Open (or re-focus) a tab, deduped by id; reveals the panel. */
  openTab: (tab: DetailTab, opts?: { activate?: boolean }) => void;
  /** Close a tab; closing the last one hides the panel. */
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setWidth: (width: number) => void;
  /**
   * Pin a run and reveal it in a run-detail tab. Selection lives in the
   * execution store (shared with the inline graph), so the panel never holds its
   * own copy — the graph and the panel stay in sync through one focus.
   */
  showRunDetail: (runId: string, title?: string) => void;
}

export const useDetailPanelStore = create<DetailPanelState>((set, get) => ({
  open: loadOpen(),
  width: loadWidth(),
  tabs: [],
  activeTabId: null,

  openTab: (tab, opts) => {
    persist(OPEN_KEY, "true");
    set((s) => {
      const exists = s.tabs.some((t) => t.id === tab.id);
      let tabs = exists
        ? s.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...s.tabs, tab];
      // Cap the strip: a new tab beyond the limit pushes out the oldest.
      if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS);
      const activate = opts?.activate !== false;
      return {
        tabs,
        open: true,
        activeTabId: activate ? tab.id : (s.activeTabId ?? tab.id),
      };
    });
  },

  closeTab: (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id
          ? (tabs[tabs.length - 1]?.id ?? null)
          : s.activeTabId;
      // All tabs closed → hide the panel.
      if (tabs.length === 0) {
        persist(OPEN_KEY, "false");
        return { tabs, activeTabId, open: false };
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  closePanel: () => {
    persist(OPEN_KEY, "false");
    set({ open: false });
  },

  togglePanel: () => {
    if (get().open) {
      get().closePanel();
      return;
    }
    persist(OPEN_KEY, "true");
    set({ open: true });
  },

  setWidth: (width) => {
    const clamped = clampWidth(width);
    persist(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },

  showRunDetail: (runId, title) => {
    useExecutionStore.getState().focusRun(runId);
    get().openTab({
      id: runDetailTabId(runId),
      title: title ?? "详情",
      runId,
    });
  },
}));
