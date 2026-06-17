import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

export type AdminUser = components["schemas"]["AdminUserResponse"];
export type AdminUserListResponse =
  components["schemas"]["AdminUserListResponse"];
export type AdminUpdateUserRequest =
  components["schemas"]["AdminUpdateUserRequest"];

export interface ListUsersParams {
  page: number;
  pageSize: number;
  q?: string;
}

export async function listUsers(
  params: ListUsersParams,
): Promise<AdminUserListResponse> {
  const search = new URLSearchParams({
    page: String(params.page),
    page_size: String(params.pageSize),
  });
  const q = params.q?.trim();
  if (q) search.set("q", q);
  return api.get<AdminUserListResponse>(`/v1/admin/users?${search.toString()}`);
}

/**
 * Patch one account. Only the keys present in `patch` are applied (tri-state —
 * a quota key sent as `null` clears the override, a value sets it). Returns the
 * fresh record.
 */
export async function updateUser(
  userId: string,
  patch: AdminUpdateUserRequest,
): Promise<AdminUser> {
  return api.patch<AdminUser>(`/v1/admin/users/${userId}`, patch);
}
