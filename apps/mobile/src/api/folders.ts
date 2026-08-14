import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** One folder from GET /v1/folders (云端 + 本机). */
export type FolderSummary = Schemas["FolderSummary"];

export async function listFolders(): Promise<FolderSummary[]> {
  const res = await apiFetch("/v1/folders");
  if (!res.ok) throw new Error(`加载文件夹失败 (${res.status})`);
  return (await res.json()) as FolderSummary[];
}

/** Cloud folders only — mobile has no 本机传统 picker / 在此新开. */
export async function listCloudFolders(): Promise<FolderSummary[]> {
  const folders = await listFolders();
  return folders.filter((f) => f.mode === "cloud");
}

export async function getFolder(id: string): Promise<FolderSummary> {
  const res = await apiFetch(`/v1/folders/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`加载文件夹失败 (${res.status})`);
  return (await res.json()) as FolderSummary;
}

/** Rename a folder (自动建文件夹告知当场改名；不是手机上的文件夹管理面). */
export async function renameFolder(
  id: string,
  name: string,
): Promise<FolderSummary> {
  const res = await apiFetch(`/v1/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    let message = `重命名失败 (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* keep status phrasing */
    }
    throw new Error(message);
  }
  return (await res.json()) as FolderSummary;
}
