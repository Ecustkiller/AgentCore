import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Sidebar folder metadata (§七). `localDir` is an optional bound directory;
 * `localRootId` is the desktop FS root the folder is bound to (local mode marker
 * — present ⇒ this project runs on the user's machine). */
export interface FolderMeta {
  id: string;
  name: string;
  localDir: string | null;
  localRootId: string | null;
}

/** Server folder payload (`/folders`), generated from OpenAPI. */
type BackendFolder = Schemas["FolderSummary"];

export function toFolder(f: BackendFolder): FolderMeta {
  return {
    id: f.id,
    name: f.name,
    localDir: f.local_dir,
    localRootId: f.local_root_id ?? null,
  };
}

export async function listFolders(): Promise<FolderMeta[]> {
  const res = await api.get<BackendFolder[]>("/v1/folders");
  return res.map(toFolder);
}

/** Create a folder. `localRootId` binds it to a desktop FS root at creation —
 * the file hub's "添加文件夹 = 建本地绑定项目" (文件中枢统一 F2): a picked local
 * directory becomes a local project in one step. */
export async function createFolder(
  name: string,
  localDir?: string | null,
  localRootId?: string | null,
): Promise<FolderMeta> {
  const res = await api.post<BackendFolder>("/v1/folders", {
    name,
    local_dir: localDir ?? null,
    local_root_id: localRootId ?? null,
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
