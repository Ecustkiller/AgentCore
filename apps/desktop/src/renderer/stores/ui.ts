import { create } from "zustand";

interface UIState {
  graphOpen: boolean;
  searchOpen: boolean;
  theme: "light" | "dark" | "system";

  openGraph: () => void;
  closeGraph: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setTheme: (theme: UIState["theme"]) => void;
}

export const useUIStore = create<UIState>((set) => ({
  graphOpen: false,
  searchOpen: false,
  theme: "system",

  openGraph: () => set({ graphOpen: true }),
  closeGraph: () => set({ graphOpen: false }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  setTheme: (theme) => set({ theme }),
}));
