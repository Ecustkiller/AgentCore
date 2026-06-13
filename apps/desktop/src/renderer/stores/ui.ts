import { create } from "zustand";

export type ViewMode = "chat" | "graph";

interface UIState {
  viewMode: ViewMode;
  theme: "light" | "dark" | "system";

  setViewMode: (mode: ViewMode) => void;
  setTheme: (theme: UIState["theme"]) => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "chat",
  theme: "system",

  setViewMode: (mode) => set({ viewMode: mode }),
  setTheme: (theme) => set({ theme }),
}));
