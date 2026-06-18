import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { bootstrapAuth } from "@/api/auth";
import { getTokens } from "@/api/client";
import { ChatPage } from "@/pages/ChatPage";
import { LoginPage } from "@/pages/LoginPage";
import { ServiceUnavailablePage } from "@/pages/ServiceUnavailablePage";

function RequireAuth({ children }: { children: ReactNode }) {
  return getTokens() ? <>{children}</> : <Navigate to="/login" replace />;
}

function Splash() {
  return (
    <div className="screen center">
      <p className="muted">正在启动…</p>
    </div>
  );
}

type GateState =
  | { phase: "loading" }
  | { phase: "ready" } // authenticated or logged-out — RequireAuth picks the route
  | { phase: "unavailable"; reason: string };

export function App() {
  // Resolve auth before routing so RequireAuth's synchronous token check sees a
  // trustworthy state. An `unavailable` result drives a retry screen instead of a
  // login form / erroring chat page while the backend is down (mirrors desktop).
  const [state, setState] = useState<GateState>({ phase: "loading" });

  const run = useCallback((force = false) => {
    setState({ phase: "loading" });
    void bootstrapAuth(force).then((r) =>
      setState(
        r.kind === "unavailable"
          ? { phase: "unavailable", reason: r.reason }
          : { phase: "ready" },
      ),
    );
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  if (state.phase === "loading") return <Splash />;
  if (state.phase === "unavailable") {
    return (
      <ServiceUnavailablePage reason={state.reason} onRetry={() => run(true)} />
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <ChatPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
