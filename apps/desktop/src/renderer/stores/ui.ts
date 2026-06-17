import { create } from "zustand";

const USAGE_DETAIL_KEY = "agentcore:usage-detail";
const THEME_KEY = "agentcore:theme";
const SIDECAR_KEY = "agentcore:sidecar-enabled";

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

// 本地引擎（sidecar）开关——默认关（off），故缺省 / 读失败均回退 false。
function loadSidecarEnabled(): boolean {
  try {
    return localStorage.getItem(SIDECAR_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSidecarEnabled(v: boolean): void {
  try {
    localStorage.setItem(SIDECAR_KEY, String(v));
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
  /** 本地引擎（sidecar）开关（双模式工作区 §一.1）。开启后，绑定本机本地文件夹的对话由
   * 用户机器上的 `python -m agentcore.sidecar` 跑（直连本地盘），而非云端引擎遥控桌面；裸聊 /
   * 云端文件夹 / 带附件的回合仍走云。默认关——sidecar 暂非真离线（LLM 仍经云推理代理）、被委派
   * worker 强制走审批门，故先 opt-in。持久化到 `localStorage: agentcore:sidecar-enabled`。 */
  sidecarEnabled: boolean;

  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setTheme: (theme: UIState["theme"]) => void;
  setUsageDetail: (v: boolean) => void;
  toggleUsageDetail: () => void;
  setSidecarEnabled: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  theme: loadTheme(),
  usageDetail: loadUsageDetail(),
  sidecarEnabled: loadSidecarEnabled(),

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
  setSidecarEnabled: (sidecarEnabled) => {
    persistSidecarEnabled(sidecarEnabled);
    set({ sidecarEnabled });
  },
}));
