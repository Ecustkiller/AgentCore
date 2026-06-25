import { startNewConversation } from "@/lib/newConversation";
import { chord } from "@/lib/shortcuts";
import { notifyError } from "@/lib/toast";
import { exportConversation } from "@/services/conversations";
import { useConversationStore } from "@/stores/conversation";
import { useShareStore } from "@/stores/share";
import { useSidebarStore } from "@/stores/sidebar";
import { useUIStore } from "@/stores/ui";
import {
  BarChart3,
  BookOpen,
  Bug,
  Cloud,
  Compass,
  Cpu,
  Download,
  Files,
  FlaskConical,
  Gauge,
  Info,
  Keyboard,
  type LucideIcon,
  Mail,
  MessagesSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Plus,
  ScrollText,
  Settings,
  Share2,
  Sun,
  UserCog,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import type { NavigateFunction } from "react-router-dom";

/** Command palette sub-sections (Tier 2). Rendered in this fixed order, each as
 * its own group so actions stay scannable next to the entity search results. */
export type CommandCategory = "操作" | "前往" | "主题";

export const COMMAND_CATEGORY_ORDER: CommandCategory[] = [
  "操作",
  "前往",
  "主题",
];

export interface PaletteCommand {
  id: string;
  title: string;
  category: CommandCategory;
  icon: LucideIcon;
  /** Extra match terms (English / aliases) so non-literal queries still hit. */
  keywords?: string[];
  /** Right-aligned key hint, rendered as a `<kbd>` (e.g. a global shortcut). */
  shortcut?: string;
  /** Right-aligned plain hint, e.g. the current value of a toggle. */
  hint?: string;
  /** Perform the action. The palette closes itself after this runs. */
  run: () => void;
}

/** Snapshot of UI state the command list reflects (so toggle hints / the active
 * theme stay accurate) plus the router's navigate. */
export interface CommandContext {
  navigate: NavigateFunction;
  theme: "light" | "dark" | "system";
  usageDetail: boolean;
  diagnosticMode: boolean;
  sidebarCollapsed: boolean;
}

/**
 * Build the Tier 2 command list for the global palette.
 *
 * Pure data (no hooks) so the palette can rebuild it cheaply whenever the
 * reflected state changes; actions reach the stores via `getState()` / the
 * passed `navigate`. Grouped by {@link CommandCategory} at render time.
 */
export function buildPaletteCommands(ctx: CommandContext): PaletteCommand[] {
  const { navigate, theme, usageDetail, diagnosticMode, sidebarCollapsed } =
    ctx;
  const go = (path: string) => () => navigate(path);

  const commands: PaletteCommand[] = [
    // ---- 操作 (actions) ----
    {
      id: "new-conversation",
      title: "新建对话",
      category: "操作",
      icon: Plus,
      keywords: ["new", "chat", "compose", "xinjian", "duihua"],
      shortcut: chord("n"),
      run: () => startNewConversation(navigate),
    },
    {
      // 「云端随手聊」逃生口（决策 #11）：桌面默认本地后，纯云随手问答的显式入口。
      id: "new-cloud-conversation",
      title: "云端随手聊",
      category: "操作",
      icon: Cloud,
      keywords: ["cloud", "suishou", "yunduan", "linshi", "new", "chat"],
      run: () => startNewConversation(navigate, null, { cloud: true }),
    },
    {
      id: "toggle-sidebar",
      title: sidebarCollapsed ? "展开侧栏" : "收起侧栏",
      category: "操作",
      icon: PanelLeft,
      keywords: ["sidebar", "toggle", "celan", "shoouqi"],
      shortcut: chord("b"),
      run: () => useSidebarStore.getState().toggleCollapsed(),
    },
    {
      id: "toggle-usage-detail",
      title: "用量明细（Power 模式）",
      category: "操作",
      icon: Gauge,
      keywords: ["usage", "power", "token", "cost", "yongliang"],
      hint: usageDetail ? "当前：开" : "当前：关",
      run: () => useUIStore.getState().toggleUsageDetail(),
    },
    {
      // 开发者 / 诊断模式 (前端UX设计.md §十): independent of 用量明细 — surfaces
      // low-level run / trace ids for debugging, off by default.
      id: "toggle-diagnostic-mode",
      title: "开发者 / 诊断模式",
      category: "操作",
      icon: Bug,
      keywords: [
        "diagnostic",
        "developer",
        "debug",
        "trace",
        "zhenduan",
        "kaifazhe",
      ],
      hint: diagnosticMode ? "当前：开" : "当前：关",
      run: () => useUIStore.getState().toggleDiagnosticMode(),
    },
    {
      // Acts on the open conversation (导出对话). A draft has no server id yet, so
      // guard with a hint rather than silently no-op'ing.
      id: "export-conversation",
      title: "导出当前对话（Markdown）",
      category: "操作",
      icon: Download,
      keywords: ["export", "download", "daochu", "markdown", "md"],
      run: () => {
        const id = useConversationStore.getState().currentConversationId;
        if (!id) {
          notifyError("请先打开一个对话");
          return;
        }
        void exportConversation(id).catch((e) => notifyError(e, "导出失败"));
      },
    },
    {
      id: "share-conversation",
      title: "分享当前对话",
      category: "操作",
      icon: Share2,
      keywords: ["share", "link", "public", "fenxiang", "lianjie"],
      run: () => {
        const id = useConversationStore.getState().currentConversationId;
        if (!id) {
          notifyError("请先打开一个对话");
          return;
        }
        useShareStore.getState().open(id);
      },
    },

    // ---- 前往 (navigation) ----
    {
      id: "nav-conversations",
      title: "全部对话",
      category: "前往",
      icon: MessagesSquare,
      keywords: ["conversations", "all", "duihua"],
      run: go("/conversations"),
    },
    {
      id: "nav-files",
      title: "文件",
      category: "前往",
      icon: Files,
      keywords: ["files", "workspace", "wenjian", "gongzuoqu"],
      run: go("/files"),
    },
    {
      id: "nav-messages",
      title: "消息",
      category: "前往",
      icon: Mail,
      keywords: ["messages", "im", "xiaoxi"],
      run: go("/messages"),
    },
    {
      id: "nav-toolbox",
      title: "工具箱",
      category: "前往",
      icon: Settings,
      keywords: ["toolbox", "tools", "gongju"],
      run: go("/toolbox"),
    },
    {
      id: "nav-tools",
      title: "工具",
      category: "前往",
      icon: Wrench,
      keywords: ["tools", "toolbox", "gongju", "nengli"],
      run: go("/toolbox/tools"),
    },
    {
      // 技能已并入「AI 提示词」页（按需注入的工具进阶用法 / 薄技能）——保留 skills/jineng 关键词，搜「技能」仍落到这里。
      id: "nav-guidelines",
      title: "AI 提示词",
      category: "前往",
      icon: ScrollText,
      keywords: [
        "guidelines",
        "prompt",
        "skills",
        "consult",
        "zhunze",
        "tishici",
        "jineng",
        "nengli",
      ],
      run: go("/toolbox/guidelines"),
    },
    {
      id: "nav-manual",
      title: "产品手册",
      category: "前往",
      icon: BookOpen,
      keywords: ["manual", "guide", "docs", "help", "shouce", "chanpin"],
      run: go("/toolbox/manual"),
    },
    {
      id: "nav-mechanism",
      title: "团队运行机制",
      category: "前往",
      icon: Workflow,
      keywords: ["team", "mechanism", "graph", "tuandui"],
      run: go("/toolbox/manual/mechanism?s=panorama"),
    },
    {
      id: "nav-explore",
      title: "探索",
      category: "前往",
      icon: Compass,
      keywords: ["explore", "tansuo"],
      run: go("/explore"),
    },
    {
      id: "nav-settings",
      title: "设置",
      category: "前往",
      icon: Settings,
      keywords: ["settings", "shezhi", "more"],
      run: go("/more"),
    },
    {
      id: "nav-settings-model",
      title: "设置 · 模型",
      category: "前往",
      icon: Cpu,
      keywords: ["settings", "model", "moxing"],
      run: go("/more/model"),
    },
    {
      id: "nav-settings-account",
      title: "设置 · 账户",
      category: "前往",
      icon: UserCog,
      keywords: [
        "settings",
        "account",
        "profile",
        "password",
        "zhanghu",
        "mima",
        "ziliao",
      ],
      run: go("/more/account"),
    },
    {
      id: "nav-settings-usage",
      title: "设置 · 用量",
      category: "前往",
      icon: BarChart3,
      keywords: ["settings", "usage", "billing", "yongliang"],
      run: go("/more/usage"),
    },
    {
      id: "nav-settings-appearance",
      title: "设置 · 外观",
      category: "前往",
      icon: Palette,
      keywords: ["settings", "appearance", "theme", "waiguan"],
      run: go("/more/appearance"),
    },
    {
      id: "nav-settings-shortcuts",
      title: "设置 · 快捷键",
      category: "前往",
      icon: Keyboard,
      keywords: ["settings", "shortcuts", "keys", "kuaijiejian"],
      run: go("/more/shortcuts"),
    },
    {
      id: "nav-settings-members",
      title: "设置 · 成员",
      category: "前往",
      icon: Users,
      keywords: ["settings", "members", "team", "chengyuan"],
      run: go("/more/members"),
    },
    {
      id: "nav-settings-about",
      title: "设置 · 关于",
      category: "前往",
      icon: Info,
      keywords: ["settings", "about", "version", "guanyu"],
      run: go("/more/about"),
    },

    // ---- 主题 (theme) ----
    {
      id: "theme-light",
      title: "浅色主题",
      category: "主题",
      icon: Sun,
      keywords: ["theme", "light", "qiansec", "qianse"],
      hint: theme === "light" ? "当前" : undefined,
      run: () => useUIStore.getState().setTheme("light"),
    },
    {
      id: "theme-dark",
      title: "深色主题",
      category: "主题",
      icon: Moon,
      keywords: ["theme", "dark", "shense"],
      hint: theme === "dark" ? "当前" : undefined,
      run: () => useUIStore.getState().setTheme("dark"),
    },
    {
      id: "theme-system",
      title: "跟随系统",
      category: "主题",
      icon: Monitor,
      keywords: ["theme", "system", "auto", "genxisuitong"],
      hint: theme === "system" ? "当前" : undefined,
      run: () => useUIStore.getState().setTheme("system"),
    },
  ];

  // Dev-only doorway to the 前端预览 harness (#/preview): the route is hidden (no nav
  // item), so the palette is how you reach it. Stripped from production builds.
  if (import.meta.env.DEV) {
    commands.push({
      id: "nav-preview",
      title: "前端预览（开发）",
      category: "前往",
      icon: FlaskConical,
      keywords: [
        "preview",
        "fixtures",
        "yulan",
        "qianduan",
        "dev",
        "harness",
        "ai",
        "xunjian",
        "巡检",
        "截图",
      ],
      hint: "离线回放 AI 态",
      run: go("/preview"),
    });
  }

  return commands;
}

/** Local substring matcher: every whitespace-separated token of the query must
 * appear in the command's title / category / keywords (case-insensitive).
 * Commands are filtered client-side — unlike entity hits, which come pre-filtered
 * from the backend search. */
export function commandMatches(cmd: PaletteCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay =
    `${cmd.title} ${cmd.category} ${(cmd.keywords ?? []).join(" ")}`.toLowerCase();
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token));
}
