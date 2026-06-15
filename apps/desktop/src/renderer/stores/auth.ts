import { create } from "zustand";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  /** The user's account-default 质量档 (D2); null = inherit the operator default.
   * The settings page reads/writes this; the modes store carries the resolved one. */
  defaultModelMode: string | null;
}

/**
 * - `loading`: bootstrap window before the first probe resolves; the UI shows a
 *   splash so we never flash the login screen at an already-authed user.
 * - `unavailable`: the backend itself is unreachable (e.g. the database is
 *   down). Distinct from `unauthenticated` so we show a retry screen instead of
 *   a login form that's guaranteed to fail.
 */
export type AuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "unavailable";

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** User-facing outage reason; set only while status === "unavailable". */
  reason: string | null;
  setLoading: () => void;
  setAuthenticated: (user: AuthUser) => void;
  setUnauthenticated: () => void;
  setUnavailable: (reason: string) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  user: null,
  reason: null,
  setLoading: () => set({ status: "loading", reason: null }),
  setAuthenticated: (user) =>
    set({ status: "authenticated", user, reason: null }),
  setUnauthenticated: () =>
    set({ status: "unauthenticated", user: null, reason: null }),
  setUnavailable: (reason) =>
    set({ status: "unavailable", user: null, reason }),
}));
