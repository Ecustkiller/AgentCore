import { api } from "@/services/api";
import type { AuthUser } from "@/stores/auth";

interface BackendUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  created_at: string;
}

function toUser(u: BackendUser): AuthUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
  };
}

/** Resolve the current session from the access cookie (throws 401 if absent). */
export async function fetchMe(): Promise<AuthUser> {
  return toUser(await api.get<BackendUser>("/v1/auth/me"));
}

export async function login(
  username: string,
  password: string,
): Promise<AuthUser> {
  return toUser(
    await api.post<BackendUser>("/v1/auth/login", { username, password }),
  );
}

export interface RegisterInput {
  username: string;
  password: string;
  inviteCode: string;
  displayName?: string;
}

export async function register(input: RegisterInput): Promise<AuthUser> {
  return toUser(
    await api.post<BackendUser>("/v1/auth/register", {
      username: input.username,
      password: input.password,
      invite_code: input.inviteCode,
      display_name: input.displayName || undefined,
    }),
  );
}

export async function logout(): Promise<void> {
  await api.post("/v1/auth/logout");
}

/**
 * Dev-only convenience: log in through the real `/auth/login` flow using
 * credentials from `.env.local` (VITE_DEV_USERNAME / VITE_DEV_PASSWORD) so you
 * don't retype them on every restart.
 *
 * Returns null in production builds (the `import.meta.env.DEV` guard is statically
 * eliminated) or when the vars are unset. This never bypasses the backend auth
 * check — it just automates a normal login with a seeded dev user.
 */
export async function devAutoLogin(): Promise<AuthUser | null> {
  if (!import.meta.env.DEV) return null;
  const username = import.meta.env.VITE_DEV_USERNAME;
  const password = import.meta.env.VITE_DEV_PASSWORD;
  if (!username || !password) return null;
  try {
    return await login(username, password);
  } catch {
    return null;
  }
}
