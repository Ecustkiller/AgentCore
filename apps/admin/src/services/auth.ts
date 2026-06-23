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
