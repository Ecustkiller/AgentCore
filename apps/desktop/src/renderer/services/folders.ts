import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Sidebar folder metadata (§七). `localDir` is an optional bound directory label. */
export interface FolderMeta {
  id: string;
  name: string;
  localDir: string | null;
}

/** Server folder payload (`/folders`), generated from OpenAPI. */
type BackendFolder = Schemas["FolderSummary"];

export function toFolder(f: BackendFolder): FolderMeta {
  return {
    id: f.id,
    name: f.name,
    localDir: f.local_dir,
  };
}

export async function listFolders(): Promise<FolderMeta[]> {
  const res = await api.get<BackendFolder[]>("/v1/folders");
  return res.map(toFolder);
}

/** Create a folder (sidebar grouping only — no workspace binding). */
export async function createFolder(
  name: string,
  localDir?: string | null,
): Promise<FolderMeta> {
  const res = await api.post<BackendFolder>("/v1/folders", {
    name,
    local_dir: localDir ?? null,
  });
  return toFolder(res);
}

/** Patch a folder. Omit a field to leave it untouched; pass `local_dir: null`
 * (via `localDir: null`) to clear the bound directory. */
export async function updateFolder(
  id: string,
  patch: { name?: string; localDir?: string | null },
): Promise<FolderMeta> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.localDir !== undefined) body.local_dir = patch.localDir;
  const res = await api.patch<BackendFolder>(`/v1/folders/${id}`, body);
  return toFolder(res);
}

export async function deleteFolder(id: string): Promise<void> {
  await api.delete(`/v1/folders/${id}`);
}

/** Hard-delete a folder and every member conversation + cloud workspace (彻底删除项目). */
export async function permanentDeleteFolder(id: string): Promise<void> {
  await api.delete(`/v1/folders/${id}/permanent`);
}
