import { api, clearCsrfToken } from "@/services/api";
import type { AuthUser } from "@/stores/auth";
import type { components } from "@/types/api.generated";

type BackendUser = components["schemas"]["UserResponse"];

function toUser(u: BackendUser): AuthUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
    passwordMustChange: u.password_must_change,
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

export async function logout(): Promise<void> {
  await api.post("/v1/auth/logout");
  clearCsrfToken();
}

/** Change the signed-in user's password; this session stays logged in. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await api.post("/v1/auth/change-password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export interface ProfileUpdate {
  displayName?: string;
  email?: string | null;
}

/** Update profile; returns refreshed user for the auth store. */
export async function updateProfile(update: ProfileUpdate): Promise<AuthUser> {
  const body: Record<string, unknown> = {};
  if (update.displayName !== undefined) body.display_name = update.displayName;
  if (update.email !== undefined) body.email = update.email;
  return toUser(await api.patch<BackendUser>("/v1/auth/me", body));
}
