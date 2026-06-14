import { create } from "zustand";

/** Resize bounds for the workspace panel (mirrors the detail panel, §一). */
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 380;

const WIDTH_KEY = "agentcore:workspace-panel-width";

export const WORKSPACE_PANEL_MIN_WIDTH = MIN_WIDTH;
export const WORKSPACE_PANEL_MAX_WIDTH = MAX_WIDTH;

const clampWidth = (w: number): number =>
  Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

// localStorage is wrapped because it throws in private-mode / non-DOM (test)
// contexts; a failed read falls back to the default, a failed write keeps the
// value in memory for the session. `open` is intentionally NOT persisted — the
// panel is a per-session drill-down, so it never auto-opens on launch.
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

interface WorkspacePanelState {
  /** Panel visibility (session-only). */
  open: boolean;
  /** Docked width in px, clamped to [280, 560] (persisted). */
  width: number;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setWidth: (width: number) => void;
}

export const useWorkspacePanelStore = create<WorkspacePanelState>(
  (set, get) => ({
    open: false,
    width: loadWidth(),

    openPanel: () => set({ open: true }),
    closePanel: () => set({ open: false }),
    togglePanel: () => set({ open: !get().open }),

    setWidth: (width) => {
      const clamped = clampWidth(width);
      try {
        localStorage.setItem(WIDTH_KEY, String(clamped));
      } catch {
        /* unavailable — session-only */
      }
      set({ width: clamped });
    },
  }),
);
