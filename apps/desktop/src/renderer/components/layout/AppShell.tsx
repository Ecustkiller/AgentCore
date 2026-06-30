import { useGroupedConversations } from "@/hooks/useConversations";
import { GLOBAL_SHORTCUTS } from "@/lib/shortcuts";
import { useApplyTheme } from "@/lib/theme";
import { startRealtime, stopRealtime } from "@/services/realtime";
import { startUpdates } from "@/stores/updates";
import { useUsageStore } from "@/stores/usage";
import { useEffect, useRef } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ShareConversationDialog } from "../conversation/ShareConversationDialog";
import { Sidebar } from "../sidebar/Sidebar";
import { CommandPalette } from "./CommandPalette";
import { TitleBar } from "./TitleBar";

export function AppShell() {
  // Apply the persisted theme to the DOM and keep it in sync with the OS while
  // set to 跟随系统 (the store only holds the value; this is its sole applier).
  useApplyTheme();

  // Warm the grouped query (folders + conversations) at the shell on mount so
  // the sidebar list is ready before it renders — even if the sidebar starts
  // collapsed, the route hasn't mounted a list yet, etc. React Query owns both
  // halves now (folders via useFolders, conversations via useConversations), so
  // there's no store to hydrate here; this call only kicks off the shared fetch.
  useGroupedConversations();

  // Load the account usage summary once on mount so the FX rate (cnyPerUsd) every
  // cost row formats with is the authoritative server value, not the default
  // fallback. Best-effort: the store keeps the default rate on failure.
  useEffect(() => {
    void useUsageStore.getState().fetchSummary();
  }, []);

  // Open the per-user realtime firehose for the whole authenticated session
  // (消息IM.md §四). It lives at the shell — not the 消息 page — so unread badges
  // and incoming messages update even while the user is elsewhere; it
  // self-manages 401→refresh→reconnect and re-syncs on each (re)connect.
  useEffect(() => {
    startRealtime();
    return () => stopRealtime();
  }, []);

  // Auto-update lives at the shell so a downloaded build surfaces its "重启安装"
  // notice (and the 关于 page status stays live) regardless of the current route.
  // The main process drives the silent download + check schedule; this only mirrors
  // status and toasts when an update is ready (前端技术与架构.md §7.6).
  useEffect(() => startUpdates(), []);

  // Global keyboard shortcuts (§二) — dispatched off the single-source table in
  // lib/shortcuts.ts (also rendered by the 快捷键 settings page, so behavior and
  // the documented chord never drift). Modifier chords don't insert text, so
  // they fire regardless of focus; navigate is read via a ref so the effect
  // needn't resubscribe on every route change.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // The offline preview (#/preview) is a full-window dev surface with its own
  // scenario navigator, so the app's conversation sidebar is pure chrome there.
  // Hide it (the TitleBar stays) to give every replayed AI state — the canvas
  // view especially — the full window width.
  const { pathname } = useLocation();
  const hideSidebar = pathname === "/preview";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const match = GLOBAL_SHORTCUTS.find((s) => s.keys.includes(key));
      if (!match) return;
      e.preventDefault();
      match.run(navigateRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!hideSidebar && <Sidebar />}
        <main className="relative flex min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
      <ShareConversationDialog />
    </div>
  );
}
