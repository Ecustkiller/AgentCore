import { listGrouped } from "@/services/conversations";
import { startRealtime, stopRealtime } from "@/services/realtime";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { useSidebarStore } from "@/stores/sidebar";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "../sidebar/Sidebar";
import { CommandPalette } from "./CommandPalette";
import { TitleBar } from "./TitleBar";

export function AppShell() {
  // Hydrate the sidebar (folders + conversations) from the backend once on mount
  // so they survive a restart. Best-effort: an unauthenticated 401 or a network
  // error just leaves the sidebar with whatever the stores already have.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { folders, conversations } = await listGrouped();
        if (cancelled) return;
        useFoldersStore.getState().setFolders(folders);
        const store = useConversationStore.getState();
        // Keep any conversation created optimistically before this resolved
        // (e.g. a brand-new one prepended by the composer), then append the rest.
        const known = new Set(store.conversations.map((c) => c.id));
        store.setConversations([
          ...store.conversations,
          ...conversations.filter((c) => !known.has(c.id)),
        ]);
      } catch {
        /* best-effort hydration; sidebar falls back to session state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Global keyboard shortcuts (§二). Ctrl/Cmd+K toggles the command palette,
  // Ctrl/Cmd+N starts a new draft conversation, Ctrl/Cmd+\ or Ctrl/Cmd+B toggles
  // the sidebar. Modifier chords don't insert text, so they fire regardless of
  // focus. getState() keeps the listener identity stable; navigate is read via a
  // ref so the effect needn't resubscribe on every route change.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        useUIStore.getState().toggleSearch();
      } else if (key === "n") {
        e.preventDefault();
        // Mirror Sidebar's handleNewConversation: a draft chat (not persisted
        // until its first message) with no pending folder target.
        useFoldersStore.getState().setPendingNewChatFolder(null);
        useConversationStore.getState().switchConversation(null);
        navigateRef.current("/");
      } else if (e.key === "\\" || key === "b") {
        e.preventDefault();
        useSidebarStore.getState().toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="relative flex min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
