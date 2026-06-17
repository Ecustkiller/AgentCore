import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/services/api";
import { logout } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import { LogOut, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

// Nav for the console. Only 用户 (P0) is live; 用量 (P1) / 系统 (P2) are
// placeholders so the IA is visible without pretending the pages exist yet.
const NAV = [
  { id: "users", label: "用户", enabled: true },
  { id: "usage", label: "用量", enabled: false },
  { id: "system", label: "系统", enabled: false },
];

export function AdminShell({ children }: { children: ReactNode }) {
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

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-border border-b bg-card/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <ShieldCheck size={18} className="text-primary" />
              管理后台
            </div>
            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <span
                  key={item.id}
                  aria-current={item.enabled ? "page" : undefined}
                  title={item.enabled ? undefined : "即将上线"}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm",
                    item.enabled
                      ? "bg-accent font-medium text-accent-foreground"
                      : "cursor-not-allowed text-muted-foreground/60",
                  )}
                >
                  {item.label}
                </span>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-sm">
              {user?.displayName || user?.username}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
              <LogOut size={14} />
              退出
            </Button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
