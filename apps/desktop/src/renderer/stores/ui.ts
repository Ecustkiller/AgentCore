import { registerConversationUiClearer, uiGet, uiSet } from "@/lib/uiStorage";
import { create } from "zustand";

const DIAGNOSTIC_MODE_KEY = "diagnostic-mode";
const THEME_KEY = "theme";
const SIDECAR_KEY = "sidecar-enabled";
const CONVERSATION_VIEWS_KEY = "conversation-views";

type Theme = "light" | "dark" | "system";

// 开发者 / 诊断模式 (前端UX设计.md §十): off by default.
function loadDiagnosticMode(): boolean {
  return uiGet<boolean>(DIAGNOSTIC_MODE_KEY) === true;
}

function persistDiagnosticMode(v: boolean): void {
  uiSet(DIAGNOSTIC_MODE_KEY, v);
}

// 每对话的视图偏好（聊天 ⇄ 画布，前端UX设计.md §六）。只存「切到画布」的对话——聊天是
// 默认、不落键，故这张表恒收敛在用户偏好画布的那批对话上（守原「不无限增长」约束）。
function loadConversationViews(): Record<string, "chat" | "canvas"> {
  const parsed = uiGet<Record<string, unknown>>(CONVERSATION_VIEWS_KEY);
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, "chat" | "canvas"> = {};
  for (const [id, mode] of Object.entries(parsed)) {
    if (mode === "canvas") out[id] = "canvas";
  }
  return out;
}

function persistConversationViews(
  views: Record<string, "chat" | "canvas">,
): void {
  if (Object.keys(views).length === 0) uiSet(CONVERSATION_VIEWS_KEY, undefined);
  else uiSet(CONVERSATION_VIEWS_KEY, views);
}

// Theme is persisted so the choice survives a reload; it is *applied* to the DOM
// by lib/theme.ts (the store only holds the value). Falls back to 跟随系统.
function loadTheme(): Theme {
  const v = uiGet<string>(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function persistTheme(v: Theme): void {
  uiSet(THEME_KEY, v);
}

// 本机执行（sidecar）开关——三态偏好（双模式工作区 §7.2）。
//
// 产品：本机传统（mode=local）新开回合默认同侧 sidecar；本开关是诊断/强制关，不是「默认关→整段过桥」。
// 设置 UI「允许本机执行」：
//   - 打开 → 偏好 `on`（允许本机同侧；与 unset 对路由等价）
//   - 关闭 → 偏好 `off`（显式强制走云，诊断用）
// 持久化的是**偏好**而非有效值，故翻产品默认时不静默改写已落盘的 `on`/`off`：
//   - "unset"（无 key）→ 跟随 `SIDECAR_DEFAULT_ENABLED`（仅影响 {@link sidecarEnabled} 展示布尔；
//     路由以 `sidecarPreference === "off"` 为强制关，unset **不**挡本机传统）
//   - "on" / "off" → 用户显式选择，恒被尊重
// 新开回合路由读 `sidecarPreference`（见 `isSidecarForceOff`），勿把 `sidecarEnabled` 当默认挡板。
type SidecarPreference = "unset" | "on" | "off";

/** 未表态时 {@link sidecarEnabled} 布尔默认。保持 false——**勿**翻成全站 true 当「默认同侧」捷径；
 * 本机传统默认同侧由 `resolveSidecarRoot` 按绑定判定，与本常量解耦。"unset" 跟随此默认记入
 * `sidecarEnabled`；显式 "on"/"off" 不受影响，勿静默改写已落盘偏好。 */
const SIDECAR_DEFAULT_ENABLED = false;

/**
 * 解析持久化偏好。三态字符串为主；兼容毕业前 boolean 落盘：
 * `false` = 用户显式关过 → `off`（勿当 unset，否则翻默认时误伤显式选择）；
 * `true` = 显式开过 → `on`。无 key / 其它值 → `unset`（跟产品默认）。
 */
export function parseSidecarPreference(raw: unknown): SidecarPreference {
  if (raw === "on" || raw === true) return "on";
  if (raw === "off" || raw === false) return "off";
  return "unset";
}

function loadSidecarPreference(): SidecarPreference {
  return parseSidecarPreference(uiGet<unknown>(SIDECAR_KEY));
}

function persistSidecarPreference(p: "on" | "off"): void {
  uiSet(SIDECAR_KEY, p);
}

/** 有效开关值：未表态时取产品默认，否则取用户显式选择。 */
function resolveSidecarEnabled(pref: SidecarPreference): boolean {
  return pref === "unset" ? SIDECAR_DEFAULT_ENABLED : pref === "on";
}

function loadSidecarEnabled(): boolean {
  return resolveSidecarEnabled(loadSidecarPreference());
}

interface UIState {
  searchOpen: boolean;
  /** Prefill for the next palette open; consumed on open. */
  searchInitialQuery: string;
  /** Open directly in the bookmarks facet (命令面板「已收藏」); consumed on open. */
  searchInitialBookmarks: boolean;
  theme: Theme;
  /** 开发者 / 诊断模式 (前端UX设计.md §十). When true, low-level execution
   * diagnostics (run / trace ids、调度埋点等) surface in run detail — dev-only
   * noise kept off the 大众 path. 「复制排查包」(错误卡 / 气泡更多) 不依赖本开关。
   * Persisted via uiStorage (`agentcore:diagnostic-mode`). */
  diagnosticMode: boolean;
  /** 每对话的视图模式（聊天 ⇄ 画布双视图，前端UX设计.md §六）。默认聊天（`"chat"`），
   * 用户可在对话顶栏切到画布（`"canvas"`）。画布已毕业（无实验开关），入口恒显示。
   * **持久化**到 `agentcore:conversation-views`，但只落「切到画布」的对话（切回聊天
   * 即删键）→ 表恒收敛、不无限增长；未表态 / 草稿（无 id）恒为聊天。 */
  conversationViews: Record<string, "chat" | "canvas">;
  /** 本机执行偏好折成的展示布尔（= `resolveSidecarEnabled`；unset→`SIDECAR_DEFAULT_ENABLED`）。
   * **不是**新开回合路由挡板——路由看 {@link sidecarPreference} 是否显式 `off`（强制关）。
   * 设置面应用 `preference !== "off"` 表示「允许」，以免 unset 显示关却仍默认同侧。 */
  sidecarEnabled: boolean;
  /** 本机执行**持久化偏好**（三态）：`unset` / `on` = 允许本机传统同侧；`off` = 诊断强制走云。
   * 翻产品默认时不静默改写已落盘偏好。持久化到 `agentcore:sidecar-enabled`。 */
  sidecarPreference: SidecarPreference;

  openSearch: (initialQuery?: string, opts?: { bookmarks?: boolean }) => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setTheme: (theme: UIState["theme"]) => void;
  setDiagnosticMode: (v: boolean) => void;
  toggleDiagnosticMode: () => void;
  setConversationView: (
    conversationId: string,
    mode: "chat" | "canvas",
  ) => void;
  setSidecarEnabled: (v: boolean) => void;
}

/** Full-screen turn detail view (`#/conversations/:id/turn/:turnId?view=`). */
export type TurnDetailView = "graph" | "debate" | "compare";

/** Build the hash-route path for a turn's full-screen detail page. */
export function turnDetailPath(
  conversationId: string,
  turnId: string,
  view?: TurnDetailView,
  comparePair?: [string, string],
  opts?: { autoplay?: boolean },
): string {
  const path = `/conversations/${conversationId}/turn/${turnId}`;
  const params = new URLSearchParams();
  if (view) params.set("view", view);
  if (comparePair) {
    params.set("a", comparePair[0]);
    params.set("b", comparePair[1]);
  }
  if (opts?.autoplay) params.set("autoplay", "1");
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  searchInitialQuery: "",
  searchInitialBookmarks: false,
  theme: loadTheme(),
  diagnosticMode: loadDiagnosticMode(),
  conversationViews: loadConversationViews(),
  sidecarPreference: loadSidecarPreference(),
  sidecarEnabled: loadSidecarEnabled(),

  // Default "" is required: Sidebar/TitleBar call openSearch() with no args.
  // Without it, searchInitialQuery becomes undefined and CommandPalette crashes
  // on query.trim() (regressed in 1ee81cee when the default was dropped).
  openSearch: (initialQuery, opts) =>
    set({
      searchOpen: true,
      searchInitialQuery: initialQuery ?? "",
      searchInitialBookmarks: opts?.bookmarks ?? false,
    }),
  closeSearch: () =>
    set({
      searchOpen: false,
      searchInitialQuery: "",
      searchInitialBookmarks: false,
    }),
  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },
  setDiagnosticMode: (diagnosticMode) => {
    persistDiagnosticMode(diagnosticMode);
    set({ diagnosticMode });
  },
  toggleDiagnosticMode: () =>
    set((s) => {
      const diagnosticMode = !s.diagnosticMode;
      persistDiagnosticMode(diagnosticMode);
      return { diagnosticMode };
    }),
  setConversationView: (conversationId, mode) =>
    set((s) => {
      const conversationViews = { ...s.conversationViews };
      // Chat is the default → store only canvas overrides so the persisted map
      // stays bounded (switching back to chat drops the key).
      if (mode === "canvas") conversationViews[conversationId] = "canvas";
      else delete conversationViews[conversationId];
      persistConversationViews(conversationViews);
      return { conversationViews };
    }),
  setSidecarEnabled: (sidecarEnabled) => {
    const sidecarPreference: SidecarPreference = sidecarEnabled ? "on" : "off";
    persistSidecarPreference(sidecarPreference);
    set({ sidecarEnabled, sidecarPreference });
  },
}));

registerConversationUiClearer((conversationId) => {
  const views = useUIStore.getState().conversationViews;
  if (!(conversationId in views)) return;
  const conversationViews = { ...views };
  delete conversationViews[conversationId];
  persistConversationViews(conversationViews);
  useUIStore.setState({ conversationViews });
});
