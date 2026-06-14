import { listGrouped } from "@/services/conversations";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
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

  // Global command palette shortcut (Ctrl/Cmd+K). Toggles so the same chord
  // opens and dismisses; the palette itself owns Escape + arrow navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        useUIStore.getState().toggleSearch();
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
