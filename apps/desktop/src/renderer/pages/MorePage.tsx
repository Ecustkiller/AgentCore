import { PageContainer } from "@/components/layout/PageContainer";
import { useAuthStore } from "@/stores/auth";
import {
  ArrowLeft,
  Gauge,
  Info,
  KeyRound,
  Keyboard,
  Palette,
  Settings,
  SlidersHorizontal,
  Users,
  Workflow,
} from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

const BASE_SECTIONS = [
  { icon: Settings, label: "通用", path: "/more" },
  { icon: KeyRound, label: "模型配置", path: "/more/model" },
  { icon: SlidersHorizontal, label: "质量档", path: "/more/model-modes" },
  { icon: Workflow, label: "团队运行机制", path: "/more/mechanism" },
  { icon: Gauge, label: "用量", path: "/more/usage" },
  { icon: Palette, label: "外观", path: "/more/appearance" },
  { icon: Keyboard, label: "快捷键", path: "/more/shortcuts" },
];

const ABOUT_SECTION = { icon: Info, label: "关于", path: "/more/about" };

export function MorePage() {
  const navigate = useNavigate();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  // Invite management is admin-only; hide the entry otherwise (the page also guards).
  const sections = [
    ...BASE_SECTIONS,
    ...(isAdmin ? [{ icon: Users, label: "成员", path: "/more/members" }] : []),
    ABOUT_SECTION,
  ];

  return (
    <div className="flex h-full w-full">
      {/* Secondary navigation */}
      <nav className="flex w-[200px] shrink-0 flex-col border-r border-border bg-muted/30">
        <div className="flex h-12 items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft size={14} />
          </button>
          <span className="text-sm font-medium">更多</span>
        </div>

        <div className="space-y-0.5 px-2">
          {sections.map((section) => (
            <NavLink
              key={section.path}
              to={section.path}
              end={section.path === "/more"}
              className={({ isActive }) =>
                `flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm ${
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`
              }
            >
              <section.icon size={14} className="shrink-0" />
              <span>{section.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Content area */}
      <PageContainer width="content" className="flex-1">
        <Outlet />
      </PageContainer>
    </div>
  );
}
