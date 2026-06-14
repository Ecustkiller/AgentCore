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

/** Kind of surface a tab shows. All bind to the current execution projection. */
export type DetailTabKind = "task-progress" | "run-detail" | "task-graph";

export interface DetailTab {
  /** Dedup identity: the kind for singletons, `run-detail:<runId>` per run. */
  id: string;
  kind: DetailTabKind;
  /** Label shown in the tab strip. */
  title: string;
  /** Pinned run, for `run-detail` tabs only. */
  runId?: string;
}

const PROGRESS_TAB: DetailTab = {
  id: "task-progress",
  kind: "task-progress",
  title: "进度",
};
const GRAPH_TAB: DetailTab = {
  id: "task-graph",
  kind: "task-graph",
  title: "协作图",
};

export const runDetailTabId = (runId: string): string => `run-detail:${runId}`;

interface DetailPanelState {
  /** Panel visibility (persisted). */
  open: boolean;
  /** Docked width in px, clamped to [280, 560] (persisted). */
  width: number;
  /** Open tabs, left→right (session-level — bound to the current execution). */
  tabs: DetailTab[];
  /** Active tab id, or null when the panel holds no tabs. */
  activeTabId: string | null;
  /**
   * Set once the user opens/closes the panel by hand. Suppresses auto-open for
   * the rest of the session so a deliberate "I closed it" choice is respected
   * across later multi-agent turns.
   */
  manualOverride: boolean;
  /**
   * Execution id the current tab set belongs to. When a new turn declares a new
   * execution, tabs reset to the progress overview (run-detail tabs reference
   * run ids that only exist within their own execution).
   */
  boundExecutionId: string | null;

  /** Open (or re-focus) a tab, deduped by id; reveals the panel. */
  openTab: (tab: DetailTab, opts?: { activate?: boolean }) => void;
  /** Close a tab; closing the last one hides the panel. */
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  /** Open the progress overview tab — the task card's bridge into Layer 2. */
  openProgress: () => void;
  /** Open the embedded collaboration-graph tab. */
  openGraphTab: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setWidth: (width: number) => void;
  /**
   * Auto-open on a multi-agent turn unless the user overrode it this session.
   * Resets the tab set to the progress overview when a new execution starts;
   * an incremental delegate batch (same id) keeps the existing tabs.
   */
  autoOpenForPlan: (
    planType: "single_agent" | "multi_agent",
    executionId: string,
  ) => void;
  /**
   * Pin a run and reveal it in a run-detail tab. Selection lives in the
   * execution store (shared with the graph + task card), so the panel never
   * holds its own copy — the three surfaces stay in sync through one focus.
   */
  showRunDetail: (runId: string, title?: string) => void;
}

export const useDetailPanelStore = create<DetailPanelState>((set, get) => ({
  open: loadOpen(),
  width: loadWidth(),
  tabs: [],
  activeTabId: null,
  manualOverride: false,
  boundExecutionId: null,

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
        manualOverride: true,
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
      // All tabs closed → hide the panel and remember the manual choice.
      if (tabs.length === 0) {
        persist(OPEN_KEY, "false");
        return { tabs, activeTabId, open: false, manualOverride: true };
      }
      return { tabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  openProgress: () => get().openTab(PROGRESS_TAB),

  openGraphTab: () => get().openTab(GRAPH_TAB),

  closePanel: () => {
    persist(OPEN_KEY, "false");
    set({ open: false, manualOverride: true });
  },

  togglePanel: () => {
    const s = get();
    if (s.open) {
      get().closePanel();
      return;
    }
    persist(OPEN_KEY, "true");
    set({
      open: true,
      manualOverride: true,
      tabs: s.tabs.length ? s.tabs : [PROGRESS_TAB],
      activeTabId: s.activeTabId ?? s.tabs[0]?.id ?? PROGRESS_TAB.id,
    });
  },

  setWidth: (width) => {
    const clamped = clampWidth(width);
    persist(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },

  autoOpenForPlan: (planType, executionId) => {
    if (planType !== "multi_agent") return;
    const s = get();
    const isNewExecution = executionId !== s.boundExecutionId;

    if (isNewExecution) {
      // New turn → start from the progress overview; drop the prior turn's tabs
      // (their run-detail run ids belong to a now-cleared execution).
      set({
        tabs: [PROGRESS_TAB],
        activeTabId: PROGRESS_TAB.id,
        boundExecutionId: executionId,
      });
    } else if (!s.tabs.some((t) => t.id === PROGRESS_TAB.id)) {
      // Same execution (delegate batch) with the overview closed → re-add it.
      set((cur) => ({
        tabs: [PROGRESS_TAB, ...cur.tabs],
        activeTabId: cur.activeTabId ?? PROGRESS_TAB.id,
      }));
    }

    if (!get().manualOverride && !get().open) {
      persist(OPEN_KEY, "true");
      set({ open: true });
    }
  },

  showRunDetail: (runId, title) => {
    useExecutionStore.getState().focusRun(runId);
    get().openTab({
      id: runDetailTabId(runId),
      kind: "run-detail",
      title: title ?? "详情",
      runId,
    });
  },
}));
