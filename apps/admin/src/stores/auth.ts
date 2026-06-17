import { create } from "zustand";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
}

/**
 * - `loading`: bootstrap window before the first `/auth/me` probe resolves.
 * - `forbidden`: a valid session whose account is **not** an admin — the console
 *   is admin-only, so we show a "需要管理员权限" wall instead of the dashboard.
 * - `unavailable`: the backend is unreachable (transport failure).
 */
export type AuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "forbidden"
  | "unavailable";

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  setLoading: () => void;
  setAuthenticated: (user: AuthUser) => void;
  setUnauthenticated: () => void;
  setForbidden: (user: AuthUser) => void;
  setUnavailable: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  user: null,
  setLoading: () => set({ status: "loading" }),
  setAuthenticated: (user) => set({ status: "authenticated", user }),
  setUnauthenticated: () => set({ status: "unauthenticated", user: null }),
  setForbidden: (user) => set({ status: "forbidden", user }),
  setUnavailable: () => set({ status: "unavailable", user: null }),
}));
