import { WindowControls } from "@/components/layout/WindowControls";
import { Button, SurfaceRowButton } from "@/components/ui";
import { isMac, macTitleBarInsetClass } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/ui";
import {
  Activity,
  ArrowLeft,
  BookMarked,
  BookOpen,
  Brain,
  ChevronLeft,
  ChevronRight,
  Compass,
  Crown,
  FolderOpen,
  Hand,
  HelpCircle,
  Layers,
  LayoutGrid,
  LifeBuoy,
  Lock,
  type LucideIcon,
  MessageSquare,
  Network,
  PlayCircle,
  Rocket,
  Route,
  Search,
  Settings,
  ShieldCheck,
  Target,
  UsersRound,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

export interface ManualNavItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** For sections within a chapter page, used as scroll target */
  scrollTo?: string;
}

export interface ManualChapter {
  id: string;
  path: string;
  label: string;
  items: ManualNavItem[];
}

export const CHAPTERS: ManualChapter[] = [
  {
    id: "intro",
    path: "/toolbox/manual/intro",
    label: "认识 AgentCore",
    items: [
      { id: "what", label: "这是什么", Icon: Compass },
      { id: "mindset", label: "核心心智", Icon: Crown },
      { id: "quickstart", label: "快速上手", Icon: Rocket },
    ],
  },
  {
    id: "collaboration",
    path: "/toolbox/manual/collaboration",
    label: "指挥你的团队",
    items: [
      { id: "collab-overview", label: "团队协作", Icon: Network },
      { id: "briefing", label: "怎么下任务", Icon: Target },
      { id: "roles", label: "角色分配", Icon: UsersRound },
      { id: "progress", label: "任务进度", Icon: Activity },
      { id: "checkpoint", label: "检查点与审批", Icon: ShieldCheck },
      { id: "control", label: "中途接管", Icon: Hand },
      { id: "memory", label: "记忆", Icon: Brain },
    ],
  },
  {
    id: "mechanism",
    path: "/toolbox/manual/mechanism",
    label: "看懂协作（选读）",
    items: [
      { id: "live", label: "看团队跑一遍", Icon: PlayCircle },
      { id: "legend", label: "看懂协作图", Icon: BookOpen },
      { id: "panorama", label: "运行时全景", Icon: Layers },
      { id: "turnflow", label: "协作回合", Icon: Route },
      { id: "scenarios", label: "机制场景", Icon: LayoutGrid },
    ],
  },
  {
    id: "reference",
    path: "/toolbox/manual/reference",
    label: "参考 · 排查 · 信任",
    items: [
      { id: "chat", label: "对话", Icon: MessageSquare },
      { id: "tools", label: "工具与能力", Icon: Wrench },
      { id: "workspace", label: "工作区与文件", Icon: FolderOpen },
      { id: "settings", label: "设置速查", Icon: Settings },
      { id: "faq", label: "常见问题", Icon: HelpCircle },
      { id: "troubleshooting", label: "故障排查", Icon: LifeBuoy },
      { id: "privacy", label: "数据与隐私", Icon: Lock },
      { id: "glossary", label: "术语", Icon: BookMarked },
    ],
  },
];

/** 扁平条目索引：覆盖全部章节小节，供侧栏搜索过滤。 */
const SEARCH_ENTRIES = CHAPTERS.flatMap((chapter) =>
  chapter.items.map((item) => ({
    id: `${chapter.id}-${item.id}`,
    itemId: item.id,
    label: item.label,
    group: chapter.label,
    Icon: item.Icon,
    to: `${chapter.path}?s=${item.id}`,
  })),
);

function getAdjacentChapters(currentPath: string) {
  const idx = CHAPTERS.findIndex((c) => currentPath.startsWith(c.path));
  return {
    prev: idx > 0 ? CHAPTERS[idx - 1] : null,
    next: idx < CHAPTERS.length - 1 ? CHAPTERS[idx + 1] : null,
  };
}

export function ManualShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const exit = useCallback(() => navigate("/toolbox"), [navigate]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const [activeId, setActiveId] = useState<string | null>(null);

  const currentChapter = CHAPTERS.find((c) =>
    location.pathname.startsWith(c.path),
  );

  const results = useMemo(() => {
    if (!q) return [];
    return SEARCH_ENTRIES.filter(
      (e) =>
        e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q),
    );
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useUIStore.getState().searchOpen) return;
      exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  // 滚动高亮（scroll-spy）：观察当前章节各小节标题，高亮目录中对应项。
  // biome-ignore lint/correctness/useExhaustiveDependencies: `location.pathname` resets scroll-spy when switching manual chapters.
  useEffect(() => {
    setActiveId(currentChapter?.items[0]?.id ?? null);
    if (!currentChapter) return;
    const root = scrollRef.current;
    if (!root) return;
    let obs: IntersectionObserver | null = null;
    // 等子页 section 挂载后再观察（Outlet 在本帧后渲染）。
    const raf = requestAnimationFrame(() => {
      const els = currentChapter.items
        .map((it) => document.getElementById(it.id))
        .filter((el): el is HTMLElement => el != null);
      if (els.length === 0) return;
      obs = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort(
              (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
            );
          if (visible[0]) setActiveId(visible[0].target.id);
        },
        { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
      );
      for (const el of els) obs.observe(el);
    });
    return () => {
      cancelAnimationFrame(raf);
      obs?.disconnect();
    };
  }, [currentChapter, location.pathname]);

  const handleNavClick = (chapter: ManualChapter, itemId: string) => {
    if (location.pathname !== chapter.path) {
      navigate(`${chapter.path}?s=${itemId}`);
    } else {
      document
        .getElementById(itemId)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(itemId);
    }
  };

  const { prev, next } = getAdjacentChapters(location.pathname);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <header
        className={`flex h-12 shrink-0 items-center border-b border-border [-webkit-app-region:drag] ${isMac ? macTitleBarInsetClass : ""}`}
      >
        <Button
          variant="neutral"
          size="md"
          onClick={exit}
          icon={<ArrowLeft size={16} />}
          className="ml-2 [-webkit-app-region:no-drag]"
        >
          返回
        </Button>
        <span className="ml-1 text-sm font-medium text-foreground">
          产品手册
        </span>
        {currentChapter && (
          <>
            <ChevronRight
              size={14}
              className="ml-1.5 text-muted-foreground/60"
            />
            <span className="ml-1.5 text-sm text-muted-foreground">
              {currentChapter.label}
            </span>
          </>
        )}
        <div className="flex-1" />
        <WindowControls
          className="flex items-center [-webkit-app-region:no-drag]"
          buttonClassName="size-12 rounded-none"
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left sidebar：常驻完整目录 + 搜索 */}
        <nav className="hidden w-[260px] shrink-0 flex-col overflow-hidden border-r border-border bg-muted/30 md:flex">
          <div className="shrink-0 p-3">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索手册…"
                className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
            {q ? (
              <div className="space-y-0.5">
                {results.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    没找到相关内容
                  </p>
                ) : (
                  results.map((r) => {
                    const Icon = r.Icon;
                    return (
                      <SurfaceRowButton
                        key={r.id}
                        variant="settings"
                        onClick={() => {
                          navigate(r.to);
                          setQuery("");
                        }}
                        className="h-auto gap-2.5 px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      >
                        <Icon size={16} className="shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{r.label}</span>
                          <span className="block truncate text-xs text-muted-foreground/70">
                            {r.group}
                          </span>
                        </span>
                      </SurfaceRowButton>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="space-y-5">
                {CHAPTERS.map((chapter) => {
                  const isCurrent = currentChapter?.id === chapter.id;
                  return (
                    <div key={chapter.id}>
                      <button
                        type="button"
                        onClick={() => navigate(chapter.path)}
                        className={cn(
                          "w-full px-3 pb-1.5 text-left text-xs font-medium transition-colors",
                          isCurrent
                            ? "text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {chapter.label}
                      </button>
                      <div className="space-y-0.5">
                        {chapter.items.map((item) => {
                          const Icon = item.Icon;
                          const isActive = isCurrent && activeId === item.id;
                          return (
                            <SurfaceRowButton
                              key={item.id}
                              variant="settings"
                              onClick={() => handleNavClick(chapter, item.id)}
                              className={cn(
                                "h-9 gap-2.5 px-3 text-sm hover:bg-accent/60 hover:text-foreground",
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              <Icon size={16} className="shrink-0" />
                              <span className="truncate">{item.label}</span>
                            </SurfaceRowButton>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </nav>

        {/* Content area */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />

          {/* Prev / Next navigation */}
          {(prev || next) && (
            <div className="mx-auto w-full max-w-3xl px-6 pb-10">
              <div className="flex items-center justify-between border-t border-border pt-6">
                {prev ? (
                  <Button
                    variant="neutral"
                    size="md"
                    onClick={() => navigate(prev.path)}
                    icon={<ChevronLeft size={16} />}
                  >
                    {prev.label}
                  </Button>
                ) : (
                  <div />
                )}
                {next ? (
                  <Button
                    variant="neutral"
                    size="md"
                    onClick={() => navigate(next.path)}
                    className="flex-row-reverse"
                    icon={<ChevronRight size={16} />}
                  >
                    {next.label}
                  </Button>
                ) : (
                  <div />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
