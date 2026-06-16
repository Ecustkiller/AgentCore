import { create } from "zustand";

const USAGE_DETAIL_KEY = "agentcore:usage-detail";
const THEME_KEY = "agentcore:theme";

type Theme = "light" | "dark" | "system";

// localStorage is wrapped: it throws in private-mode / non-DOM (test) contexts.
// A failed read falls back to 大众 (false); a failed write keeps the value in
// memory for the session.
function loadUsageDetail(): boolean {
  try {
    return localStorage.getItem(USAGE_DETAIL_KEY) === "true";
  } catch {
    return false;
  }
}

function persistUsageDetail(v: boolean): void {
  try {
    localStorage.setItem(USAGE_DETAIL_KEY, String(v));
  } catch {
    /* unavailable — session-only */
  }
}

// Theme is persisted so the choice survives a reload; it is *applied* to the DOM
// by lib/theme.ts (the store only holds the value). Falls back to 跟随系统.
function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function persistTheme(v: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, v);
  } catch {
    /* unavailable — session-only */
  }
}

interface UIState {
  searchOpen: boolean;
  theme: Theme;
  /** 大众/power 用量明细开关 (§7.1). When true, compact surfaces reveal raw
   * token / cache detail and run-detail「资源消耗」defaults to expanded. Money (¥)
   * is never gated by this — it stays visible in both modes (§7.1). Persisted to
   * `localStorage: agentcore:usage-detail`. */
  usageDetail: boolean;

  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setTheme: (theme: UIState["theme"]) => void;
  setUsageDetail: (v: boolean) => void;
  toggleUsageDetail: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  theme: loadTheme(),
  usageDetail: loadUsageDetail(),

  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },
  setUsageDetail: (usageDetail) => {
    persistUsageDetail(usageDetail);
    set({ usageDetail });
  },
  toggleUsageDetail: () =>
    set((s) => {
      const usageDetail = !s.usageDetail;
      persistUsageDetail(usageDetail);
      return { usageDetail };
    }),
}));
