import { ArrowLeft, Info, Keyboard, Palette, Settings } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

const SECTIONS = [
  { icon: Settings, label: "通用", path: "/more" },
  { icon: Palette, label: "外观", path: "/more/appearance" },
  { icon: Keyboard, label: "快捷键", path: "/more/shortcuts" },
  { icon: Info, label: "关于", path: "/more/about" },
] as const;

export function MorePage() {
  const navigate = useNavigate();

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
          {SECTIONS.map((section) => (
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
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
