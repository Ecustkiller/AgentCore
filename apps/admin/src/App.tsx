import { AdminShell } from "@/components/AdminShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { LoginPage } from "@/pages/LoginPage";
import { UsersPage } from "@/pages/UsersPage";
import { NetworkError, setUnauthorizedHandler } from "@/services/api";
import { fetchMe, logout } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import { ShieldAlert } from "lucide-react";
import { useEffect } from "react";

async function bootstrap(): Promise<void> {
  const {
    setAuthenticated,
    setForbidden,
    setUnauthenticated,
    setUnavailable,
    setLoading,
  } = useAuthStore.getState();
  setLoading();
  try {
    const user = await fetchMe();
    if (user.role === "admin") setAuthenticated(user);
    else setForbidden(user);
  } catch (err) {
    // Transport failure → outage (retry screen); anything else (401) → logged out.
    if (err instanceof NetworkError) setUnavailable();
    else setUnauthenticated();
  }
}

export function App() {
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    // A request that stays 401 after a refresh drops the whole app to login.
    setUnauthorizedHandler(() => useAuthStore.getState().setUnauthenticated());
    void bootstrap();
    return () => setUnauthorizedHandler(null);
  }, []);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <CenteredCard
        title="无法连接后端"
        description="请确认后端服务已启动后重试。"
      >
        <Button onClick={() => void bootstrap()}>重试</Button>
      </CenteredCard>
    );
  }

  if (status === "unauthenticated") {
    return <LoginPage />;
  }

  if (status === "forbidden") {
    return (
      <CenteredCard
        icon={<ShieldAlert size={24} className="text-warning" />}
        title="需要管理员权限"
        description="当前账号不是平台管理员，无法访问管理后台。"
      >
        <Button
          variant="outline"
          onClick={() =>
            void logout().finally(() =>
              useAuthStore.getState().setUnauthenticated(),
            )
          }
        >
          退出登录
        </Button>
      </CenteredCard>
    );
  }

  return (
    <AdminShell>
      <UsersPage />
    </AdminShell>
  );
}

function CenteredCard({
  icon,
  title,
  description,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        {icon && (
          <div className="flex size-12 items-center justify-center rounded-xl bg-warning/10">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
