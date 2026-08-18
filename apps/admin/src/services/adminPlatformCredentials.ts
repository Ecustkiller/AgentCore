import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

export type PlatformCredentialView =
  components["schemas"]["PlatformCredentialView"];
export type PlatformCredentialListResponse =
  components["schemas"]["PlatformCredentialListResponse"];
export type CreatePlatformCredentialRequest =
  components["schemas"]["CreatePlatformCredentialRequest"];
export type UpdatePlatformCredentialRequest =
  components["schemas"]["UpdatePlatformCredentialRequest"];

export async function listPlatformCredentials(): Promise<PlatformCredentialListResponse> {
  return api.get<PlatformCredentialListResponse>(
    "/v1/admin/platform-credentials",
  );
}

export async function createPlatformCredential(
  body: CreatePlatformCredentialRequest,
): Promise<PlatformCredentialView> {
  return api.post<PlatformCredentialView>(
    "/v1/admin/platform-credentials",
    body,
  );
}

export async function updatePlatformCredential(
  credentialId: string,
  body: UpdatePlatformCredentialRequest,
): Promise<PlatformCredentialView> {
  return api.patch<PlatformCredentialView>(
    `/v1/admin/platform-credentials/${credentialId}`,
    body,
  );
}

export async function deletePlatformCredential(
  credentialId: string,
): Promise<void> {
  await api.delete(`/v1/admin/platform-credentials/${credentialId}`);
}

export async function clearPlatformCredentialRuntime(
  credentialId: string,
): Promise<PlatformCredentialView> {
  return api.post<PlatformCredentialView>(
    `/v1/admin/platform-credentials/${credentialId}/clear-runtime`,
  );
}
