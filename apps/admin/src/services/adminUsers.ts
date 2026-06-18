import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

export type AdminUser = components["schemas"]["AdminUserResponse"];
export type AdminUserListResponse =
  components["schemas"]["AdminUserListResponse"];
export type AdminUpdateUserRequest =
  components["schemas"]["AdminUpdateUserRequest"];
export type AdminUserDetail = components["schemas"]["AdminUserDetail"];
export type AdminConversationLine =
  components["schemas"]["AdminConversationLine"];
export type RoleCostLine = components["schemas"]["RoleCostLine"];
export type AdminResetPasswordResponse =
  components["schemas"]["AdminResetPasswordResponse"];

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

/**
 * 用户详情下钻: one account's record + its own usage (today/month/trend/by-role)
 * + recent conversations + recent turn activity (each drillable into 会话复盘).
 */
export async function fetchUserDetail(
  userId: string,
): Promise<AdminUserDetail> {
  return api.get<AdminUserDetail>(`/v1/admin/users/${userId}/detail`);
}

/**
 * Rotate an account's password to a fresh one-off string and kill every active
 * session (all refresh tokens revoked). The temp password is shown *once* in the
 * response — there is no way to retrieve it again — so the caller must surface it
 * to the operator immediately.
 */
export async function resetUserPassword(
  userId: string,
): Promise<AdminResetPasswordResponse> {
  return api.post<AdminResetPasswordResponse>(
    `/v1/admin/users/${userId}/reset-password`,
  );
}
