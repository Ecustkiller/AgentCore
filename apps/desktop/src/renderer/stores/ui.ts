import { create } from "zustand";

const USAGE_DETAIL_KEY = "agentcore:usage-detail";
const THEME_KEY = "agentcore:theme";
const SIDECAR_KEY = "agentcore:sidecar-enabled";
const CONVERSATION_VIEWS_KEY = "agentcore:conversation-views";

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

// 每对话的视图偏好（聊天 ⇄ 画布，前端UX设计.md §六）。只存「切到画布」的对话——聊天是
// 默认、不落键，故这张表恒收敛在用户偏好画布的那批对话上（守原「不无限增长」约束）。同 usageDetail
// 的 localStorage 包裹（私密模式 / 非 DOM 测试环境抛错时回退空表、退化为会话内存态）。
function loadConversationViews(): Record<string, "chat" | "canvas"> {
  try {
    const raw = localStorage.getItem(CONVERSATION_VIEWS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, "chat" | "canvas"> = {};
    for (const [id, mode] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (mode === "canvas") out[id] = "canvas";
    }
    return out;
  } catch {
    return {};
  }
}

function persistConversationViews(
  views: Record<string, "chat" | "canvas">,
): void {
  try {
    localStorage.setItem(CONVERSATION_VIEWS_KEY, JSON.stringify(views));
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

// 本地引擎（sidecar）开关——三态偏好（双模式工作区 §一.1 / 本地引擎毕业方案 · 阶段三）。
//
// 为「毕业到默认开」铺路：必须区分「用户从未设过」与「用户显式关过」，否则把默认翻成开时会误
// 开那些主动关掉的人。故持久化的是**偏好**而非有效值：
//   - "unset"（无 key）→ 跟随 `SIDECAR_DEFAULT_ENABLED`（用户没表态，由产品默认决定）；
//   - "on" / "off" → 用户显式选择，恒被尊重，不受默认值变化影响。
// 有效开关 = `resolveSidecarEnabled(偏好)`，消费方（sidecarRouting）只读那个 boolean。
//
// 兼容旧布尔存储（"true"/"false"）：只有用户操作过开关才会写入，故 "true"→on、"false"→off 无
// 歧义；下次写入自动规范化为 "on"/"off"。
type SidecarPreference = "unset" | "on" | "off";

/** 本地引擎默认是否开启（用户未表态时）。已毕业到**默认开**：绑定本机本地文件夹的对话默认走
 * 本地引擎（启动失败会自动降级回云端，故默认开是安全的，见 `turns.sendTurn`）；"unset" 用户
 * 跟随此默认，显式 "on"/"off" 用户不受影响。需回退为 opt-in 时改回 false 即可。 */
const SIDECAR_DEFAULT_ENABLED = true;

function loadSidecarPreference(): SidecarPreference {
  try {
    const v = localStorage.getItem(SIDECAR_KEY);
    if (v === "on" || v === "true") return "on";
    if (v === "off" || v === "false") return "off";
    return "unset";
  } catch {
    return "unset";
  }
}

function persistSidecarPreference(p: "on" | "off"): void {
  try {
    localStorage.setItem(SIDECAR_KEY, p);
  } catch {
    /* unavailable — session-only */
  }
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
  theme: Theme;
  /** 大众/power 用量明细开关 (§7.1). When true, compact surfaces reveal raw
   * token / cache detail and run-detail「资源消耗」defaults to expanded. Money (¥)
   * is never gated by this — it stays visible in both modes (§7.1). Persisted to
   * `localStorage: agentcore:usage-detail`. */
  usageDetail: boolean;
  /** 每对话的视图模式（聊天 ⇄ 画布双视图，前端UX设计.md §六）。默认聊天（`"chat"`），
   * 用户可在对话顶栏切到画布（`"canvas"`）。画布已毕业（无实验开关），入口恒显示。
   * **持久化**到 `localStorage: agentcore:conversation-views`，但只落「切到画布」的对话（切回聊天
   * 即删键）→ 表恒收敛、不无限增长；未表态 / 草稿（无 id）恒为聊天。 */
  conversationViews: Record<string, "chat" | "canvas">;
  /** 本地引擎（sidecar）**有效**开关（双模式工作区 §一.1）：= `resolveSidecarEnabled(偏好)`，
   * 消费方（路由）只读这个 boolean。开启后，绑定本机本地文件夹的对话由用户机器上的
   * `python -m agentcore.sidecar` 跑（直连本地盘），而非云端引擎遥控桌面；裸聊 / 云端文件夹 /
   * 带附件的回合仍走云。**默认开**、可关闭——启动失败自动降级回云端（故默认开安全）；但 sidecar
   * 暂非真离线（LLM 仍经云推理代理），断网时不可用。 */
  sidecarEnabled: boolean;
  /** 本地引擎开关的**持久化偏好**（三态）：`unset` 跟随 `SIDECAR_DEFAULT_ENABLED`、`on`/`off` 为
   * 用户显式选择——为「毕业到默认开」铺路（翻默认时不误开显式关过的人）。持久化到
   * `localStorage: agentcore:sidecar-enabled`；设置开关只关心 {@link sidecarEnabled}。 */
  sidecarPreference: SidecarPreference;

  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setTheme: (theme: UIState["theme"]) => void;
  setUsageDetail: (v: boolean) => void;
  toggleUsageDetail: () => void;
  setConversationView: (conversationId: string, mode: "chat" | "canvas") => void;
  setSidecarEnabled: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  searchOpen: false,
  theme: loadTheme(),
  usageDetail: loadUsageDetail(),
  conversationViews: loadConversationViews(),
  sidecarPreference: loadSidecarPreference(),
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
