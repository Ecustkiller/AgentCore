import { LoginPage } from "@/pages/LoginPage";
import { setUnauthorizedHandler } from "@/services/api";
import { devAutoLogin, fetchMe } from "@/services/auth";
import { useAuthStore } from "@/stores/auth";
import { type ReactNode, useEffect } from "react";

/**
 * Gates the whole app behind authentication.
 *
 * On mount it probes `/auth/me` (the access cookie may already be valid) and
 * wires the api-layer 401 handler so any later unrecoverable 401 drops straight
 * back to the login screen. Children (the router) only render once authenticated.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    setUnauthorizedHandler(() => useAuthStore.getState().setUnauthenticated());
    let cancelled = false;
    void (async () => {
      try {
        const user = await fetchMe();
        if (!cancelled) useAuthStore.getState().setAuthenticated(user);
      } catch {
        // No valid session. In dev, optionally auto-login with seeded creds
        // (no-op in production); otherwise drop to the login screen.
        const devUser = await devAutoLogin();
        if (cancelled) return;
        if (devUser) useAuthStore.getState().setAuthenticated(devUser);
        else useAuthStore.getState().setUnauthenticated();
      }
    })();
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <LoginPage />;
  }

  return <>{children}</>;
}
