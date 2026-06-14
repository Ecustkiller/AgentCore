import { api } from "@/services/api";

/** Sidebar folder metadata (§七). `localDir` is an optional bound directory. */
export interface FolderMeta {
  id: string;
  name: string;
  localDir: string | null;
}

interface BackendFolder {
  id: string;
  name: string;
  local_dir: string | null;
  created_at: string;
  updated_at: string;
}

export function toFolder(f: BackendFolder): FolderMeta {
  return { id: f.id, name: f.name, localDir: f.local_dir };
}

export async function listFolders(): Promise<FolderMeta[]> {
  const res = await api.get<BackendFolder[]>("/v1/folders");
  return res.map(toFolder);
}

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
