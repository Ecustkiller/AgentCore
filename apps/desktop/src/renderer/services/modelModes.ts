import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

// REST DTOs generated from the backend OpenAPI spec (`pnpm gen:api`), aliased to
// local names (API 开发规范). 质量档 routes live under /v1/model-modes (D2).
type Schemas = components["schemas"];

export type ModelModesResponse = Schemas["ModelModesResponse"];
export type ModelModePreset = Schemas["ModelModePreset"];
export type ModelModeSummary = Schemas["ModelModeSummary"];
export type ModelModeCatalog = Schemas["ModelModeCatalog"];
export type ModelRoleOption = Schemas["ModelRoleOption"];

/** Built-in presets + the user's custom modes + the user's resolved default ref. */
export function listModelModes(): Promise<ModelModesResponse> {
  return api.get<ModelModesResponse>("/v1/model-modes");
}

/** The option space for building a custom mode: configurable roles + allowed models. */
export function fetchModelModeCatalog(): Promise<ModelModeCatalog> {
  return api.get<ModelModeCatalog>("/v1/model-modes/catalog");
}

/** Create a custom 质量档 (assignments = team-role → model id). */
export function createModelMode(
  name: string,
  assignments: Record<string, string>,
): Promise<ModelModeSummary> {
  return api.post<ModelModeSummary>("/v1/model-modes", { name, assignments });
}

/** Patch a custom mode's name and/or assignments (omitted fields stay). */
export function updateModelMode(
  id: string,
  body: { name?: string; assignments?: Record<string, string> },
): Promise<ModelModeSummary> {
  return api.patch<ModelModeSummary>(`/v1/model-modes/${id}`, body);
}

/** Soft-delete a custom mode. */
export async function deleteModelMode(id: string): Promise<void> {
  await api.delete(`/v1/model-modes/${id}`);
}

/** Set (or clear with null) the user's account-default 质量档. */
export async function setDefaultModelMode(mode: string | null): Promise<void> {
  await api.put("/v1/model-modes/default", { mode });
}

/** Set (or clear with null = inherit) a conversation's 质量档. */
export async function setConversationModelMode(
  conversationId: string,
  mode: string | null,
): Promise<void> {
  await api.patch(`/v1/conversations/${conversationId}`, { model_mode: mode });
}
