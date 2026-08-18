import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

export type BetaGroupModerator = components["schemas"]["BetaGroupModerator"];
export type BetaGroupModeratorsResponse =
  components["schemas"]["BetaGroupModeratorsResponse"];
export type StatusResponse = components["schemas"]["StatusResponse"];

/** List 内测群管理员 (``chat_members.role=admin``, not platform admin). */
export async function listBetaGroupModerators(
  signal?: AbortSignal,
): Promise<BetaGroupModeratorsResponse> {
  return api.get<BetaGroupModeratorsResponse>(
    "/v1/admin/beta-group/moderators",
    signal ? { signal } : undefined,
  );
}

/** Appoint a user as 内测群管理员 (ensures group membership). */
export async function appointBetaGroupModerator(
  userId: string,
): Promise<BetaGroupModerator> {
  return api.put<BetaGroupModerator>(
    `/v1/admin/beta-group/moderators/${encodeURIComponent(userId)}`,
  );
}

/** Revoke 内测群管理员 (role → member; stays in group). */
export async function revokeBetaGroupModerator(
  userId: string,
): Promise<StatusResponse> {
  return api.delete<StatusResponse>(
    `/v1/admin/beta-group/moderators/${encodeURIComponent(userId)}`,
  );
}
