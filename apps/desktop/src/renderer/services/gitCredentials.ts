import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

/**
 * 账户级 Git 凭据（设置 · Git 凭据 · G3）。
 * 云工作区私仓 clone/push 用；明文永不回传。REST 类型由 OpenAPI 生成。
 */

type Schemas = components["schemas"];

export type GitCredentialView = Schemas["GitCredentialView"];
export type UpsertGitCredentialInput = Schemas["UpsertGitCredentialRequest"];

export function getGitCredentials(): Promise<GitCredentialView> {
  return api.get<GitCredentialView>("/v1/users/me/git-credentials");
}

export function upsertGitCredentials(
  input: UpsertGitCredentialInput,
): Promise<GitCredentialView> {
  return api.put<GitCredentialView>("/v1/users/me/git-credentials", input);
}

export function deleteGitCredentials(): Promise<{ status: string }> {
  return api.delete<{ status: string }>("/v1/users/me/git-credentials");
}
