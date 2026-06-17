import { LoginPage } from "@/pages/LoginPage";
import { ServiceUnavailablePage } from "@/pages/ServiceUnavailablePage";
import {
  setServiceUnavailableHandler,
  setUnauthorizedHandler,
} from "@/services/api";
import { bootstrapAuth, diagnoseOutage } from "@/services/auth";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import { useAuthStore } from "@/stores/auth";
import { type ReactNode, useCallback, useEffect } from "react";

/**
 * Gates the whole app behind authentication.
 *
 * On mount it runs {@link bootstrapAuth}, which resolves to authenticated,
 * unauthenticated, or unavailable (backend down), and wires the api-layer 401
 * handler so any later unrecoverable 401 drops straight back to login. Children
 * (the router) only render once authenticated.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const reason = useAuthStore((s) => s.reason);

  const runBootstrap = useCallback(async () => {
    useAuthStore.getState().setLoading();
    const result = await bootstrapAuth();
    const store = useAuthStore.getState();
    switch (result.kind) {
      case "authenticated":
        store.setAuthenticated(result.user);
        break;
      case "unavailable":
        store.setUnavailable(result.reason);
        break;
      case "unauthenticated":
        store.setUnauthenticated();
        break;
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => useAuthStore.getState().setUnauthenticated());
    // Mid-session outage: a non-auth call hit a 5xx/network error. Confirm with
    // /readyz before taking over the screen so a one-off endpoint 500 on a
    // healthy backend doesn't blank the app.
    setServiceUnavailableHandler(() => {
      const cur = useAuthStore.getState().status;
      if (cur === "loading" || cur === "unavailable") return;
      void (async () => {
        const reason = await diagnoseOutage();
        if (reason) useAuthStore.getState().setUnavailable(reason);
      })();
    });
    void runBootstrap();
    return () => {
      setUnauthorizedHandler(null);
      setServiceUnavailableHandler(null);
    };
  }, [runBootstrap]);

  // 认证成功后预热桌面默认本地容器根（决策 #11 / 工作区对称化 D1a），使首个裸聊首发即可
  // 携带容器根、由服务端懒建本地文件夹——此刻只授权 `~/Documents/AgentCore`、不建 Folder。
  // 非桌面 / 失败时 no-op，不阻断渲染。
  useEffect(() => {
    if (status === "authenticated") void ensureDefaultContainerRoot();
  }, [status]);

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <ServiceUnavailablePage
        reason={reason ?? "无法连接后端：请确认后端服务已启动后重试。"}
        onRetry={() => void runBootstrap()}
      />
    );
  }

  if (status === "unauthenticated") {
    return <LoginPage />;
  }

  return <>{children}</>;
}
