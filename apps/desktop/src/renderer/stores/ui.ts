import { create } from "zustand";

export type ViewMode = "chat" | "graph";

interface UIState {
  viewMode: ViewMode;
  sidebarOpen: boolean;
  theme: "light" | "dark" | "system";

  setViewMode: (mode: ViewMode) => void;
  toggleSidebar: () => void;
  setTheme: (theme: UIState["theme"]) => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "chat",
  sidebarOpen: true,
  theme: "system",

  setViewMode: (mode) => set({ viewMode: mode }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setTheme: (theme) => set({ theme }),
}));
