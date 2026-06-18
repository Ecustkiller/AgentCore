import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/services/api";
import { logout } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import {
  BarChart3,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Server,
  ShieldCheck,
  Ticket,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

/**
 * The console's sections (管理员后台.md): 概览 (landing hub) / 用户 (P0) / 邀请码
 * (P0) / 分析 (P1, 成本 + 健康 merged) / 系统 (P2).
 */
export type AdminTab = "overview" | "users" | "invites" | "analytics" | "system";

const NAV: { id: AdminTab; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "users", label: "用户", icon: Users },
  { id: "invites", label: "邀请码", icon: Ticket },
  { id: "analytics", label: "分析", icon: BarChart3 },
  { id: "system", label: "系统", icon: Server },
];

export function AdminShell({
  active,
  onNavigate,
  children,
}: {
  active: AdminTab;
  onNavigate: (tab: AdminTab) => void;
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  const setUnauthenticated = useAuthStore((s) => s.setUnauthenticated);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUnauthenticated();
    }
  };

  const displayName = user?.displayName || user?.username;

  return (
    <div className="flex h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-border border-r bg-muted/30">
        <div className="flex h-14 shrink-0 items-center gap-3 px-6 font-semibold text-base text-foreground">
          <ShieldCheck size={20} className="text-primary" />
          管理后台
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === active;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onNavigate(item.id)}
                className={cn(
                  "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon size={18} className="shrink-0" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-2 border-border border-t p-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-medium uppercase">
              {(displayName ?? "?").charAt(0)}
            </div>
            <span
              className="min-w-0 flex-1 truncate text-base text-muted-foreground"
              title={displayName}
            >
              {displayName}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-2 text-muted-foreground hover:text-foreground"
            onClick={() => void handleLogout()}
          >
            <LogOut size={16} />
            退出
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
