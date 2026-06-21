import { create } from "zustand";
import {
  type StateStorage,
  createJSONStorage,
  persist,
} from "zustand/middleware";

/** localStorage when available (Electron renderer), else a no-op so persistence
 * silently degrades to session-only outside a DOM (e.g. vitest's node env) —
 * mirrors the try/catch localStorage guards used elsewhere (sidePanel.ts). */
const safeStorage = createJSONStorage<unknown>(() => {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* access denied — fall through */
  }
  const noop: StateStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  return noop;
});

interface SidebarState {
  collapsed: boolean;
  /** Per-section expand state, keyed by section id. Workspace groups key on their
   * `folderId`; an absent key means "no explicit user choice yet" (the view then
   * applies its own default — see `WorkspaceGroups`). */
  expandedSections: Record<string, boolean>;

  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleSection: (sectionId: string) => void;
  /** Explicitly set a section's expand state. Preferred over `toggleSection` where
   * the displayed default differs from the stored value (e.g. an auto-expanded
   * active group) — clicking must flip what the user *sees*, not the absent key. */
  setSection: (sectionId: string, expanded: boolean) => void;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      collapsed: false,
      expandedSections: { ungrouped: true },

      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      setCollapsed: (collapsed) => set({ collapsed }),
      toggleSection: (sectionId) =>
        set((s) => ({
          expandedSections: {
            ...s.expandedSections,
            [sectionId]: !s.expandedSections[sectionId],
          },
        })),
      setSection: (sectionId, expanded) =>
        set((s) => ({
          expandedSections: { ...s.expandedSections, [sectionId]: expanded },
        })),
    }),
    {
      name: "agentcore.sidebar",
      storage: safeStorage,
      // Persist only view prefs (rail collapse + per-workspace expand state) so
      // expanded projects stay open across restarts; methods aren't serialized.
      partialize: (s) => ({
        collapsed: s.collapsed,
        expandedSections: s.expandedSections,
      }),
    },
  ),
);
