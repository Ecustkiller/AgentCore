import { create } from "zustand";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
}

/**
 * `loading` is the bootstrap window before the first `/auth/me` resolves; the
 * UI shows a splash so we never flash the login screen at an already-authed user.
 */
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  setAuthenticated: (user: AuthUser) => void;
  setUnauthenticated: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  user: null,
  setAuthenticated: (user) => set({ status: "authenticated", user }),
  setUnauthenticated: () => set({ status: "unauthenticated", user: null }),
}));
