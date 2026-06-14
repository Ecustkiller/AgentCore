import { listConversations } from "@/services/conversations";
import { useConversationStore } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "../sidebar/Sidebar";
import { CommandPalette } from "./CommandPalette";
import { TitleBar } from "./TitleBar";

export function AppShell() {
  // Hydrate the sidebar from the backend once on mount so conversations from
  // previous sessions survive a restart. Best-effort: an unauthenticated 401 or
  // a network error just leaves the sidebar with whatever the store already has.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await listConversations();
        if (cancelled) return;
        const store = useConversationStore.getState();
        // Keep any conversation created optimistically before this resolved
        // (e.g. a brand-new one prepended by the composer), then append the rest.
        const known = new Set(store.conversations.map((c) => c.id));
        store.setConversations([
          ...store.conversations,
          ...loaded.filter((c) => !known.has(c.id)),
        ]);
      } catch {
        /* best-effort hydration; sidebar falls back to session state */
      }
    })();
    return () => {
      cancelled = true;
    };
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
