import { create } from "zustand";

interface SidebarState {
  collapsed: boolean;
  expandedSections: Record<string, boolean>;

  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleSection: (sectionId: string) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
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
}));
