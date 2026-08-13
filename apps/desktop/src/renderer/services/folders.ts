import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Sidebar / picker folder (= workspace). Mode is set at create and immutable. */
export interface FolderMeta {
  id: string;
  name: string;
  mode: "local" | "cloud";
  localRootId: string | null;
  localSubpath: string | null;
  /**
   * Where the folder sits in the user-visible cloud tree (POSIX, relative to the
   * tree root — `设计/图标`). Changes on rename / move; `id` stays the handle.
   *
   * Absent on rows an older client cached and on local folders (which live on
   * disk, not in the cloud tree) — such a folder reads as top-level, never
   * vanishes.
   */
  relPath?: string | null;
  /** `relPath`'s prefix, so the tree can be built without parsing paths. */
  parentRelPath?: string | null;
}

/** Server folder payload (`/folders`), generated from OpenAPI. */
type BackendFolder = Schemas["FolderSummary"];

export function toFolder(f: BackendFolder): FolderMeta {
  return {
    id: f.id,
    name: f.name,
    mode: f.mode,
    localRootId: f.local_root_id ?? null,
    localSubpath: f.local_subpath ?? null,
    relPath: f.rel_path ?? null,
    parentRelPath: f.parent_rel_path ?? null,
  };
}

export async function listFolders(): Promise<FolderMeta[]> {
  const res = await api.get<BackendFolder[]>("/v1/folders");
  return res.map(toFolder);
}

export interface CreateFolderInput {
  name: string;
  mode: "local" | "cloud";
  localRootId?: string | null;
  localSubpath?: string | null;
  /** Nest the new folder inside this one; omit / null = top level of 我的文件. */
  parentId?: string | null;
}

export interface CreateFolderResult {
  folder: FolderMeta;
  /** False when the server reused an existing local binding (HTTP 200). */
  created: boolean;
}

/** Create a folder (= workspace). `mode` is required and immutable after create. */
export async function createFolder(
  input: CreateFolderInput,
): Promise<CreateFolderResult> {
  const body: Schemas["CreateFolderRequest"] = {
    name: input.name,
    mode: input.mode,
    local_root_id: input.mode === "local" ? (input.localRootId ?? null) : null,
    local_subpath: input.mode === "local" ? (input.localSubpath ?? null) : null,
    parent_id: input.parentId ?? null,
  };
  const { data, status } = await api.postWithStatus<BackendFolder>(
    "/v1/folders",
    body,
  );
  return { folder: toFolder(data), created: status === 201 };
}

/**
 * Rename and/or move a folder. Mode / local bind are immutable after create.
 *
 * `parentId` is only sent when the caller explicitly asks for a move (`null`
 * means "to the top level"), so a plain rename never re-parents by omission.
 */
export async function updateFolder(
  id: string,
  patch: { name?: string; parentId?: string | null },
): Promise<FolderMeta> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if ("parentId" in patch) body.parent_id = patch.parentId ?? null;
  const res = await api.patch<BackendFolder>(`/v1/folders/${id}`, body);
  return toFolder(res);
}

export async function deleteFolder(id: string): Promise<void> {
  await api.delete(`/v1/folders/${id}`);
}

/** One recoverable folder in「最近删除」. */
export interface DeletedFolderMeta {
  id: string;
  name: string;
  mode: "local" | "cloud";
  deletedAt: string;
  /** Earliest moment the retention sweeper may purge it (server-computed). */
  purgeAt: string;
}

/** The recycle bin plus the retention window it is governed by. */
export interface FolderTrash {
  items: DeletedFolderMeta[];
  retentionDays: number;
}

type BackendDeletedFolder = Schemas["DeletedFolderSummary"];

function toDeletedFolder(f: BackendDeletedFolder): DeletedFolderMeta {
  return {
    id: f.id,
    name: f.name,
    mode: f.mode,
    deletedAt: f.deleted_at,
    purgeAt: f.purge_at,
  };
}

/** 最近删除 — folders the user deleted that are still inside the retention window. */
export async function listFolderTrash(): Promise<FolderTrash> {
  const res =
    await api.get<Schemas["DeletedFolderListResponse"]>("/v1/folders/trash");
  return {
    items: res.data.map(toDeletedFolder),
    retentionDays: res.retention_days,
  };
}

/**
 * Restore a deleted folder. Past the retention window the server answers 409
 * (「该文件夹已被清理」) — a real window, not something to retry around.
 *
 * The returned folder is authoritative: a live sibling may have taken the name
 * while this one sat in the bin, so it can come back as「名字 (2)」.
 */
export async function restoreFolder(id: string): Promise<FolderMeta> {
  const res = await api.post<BackendFolder>(`/v1/folders/trash/${id}/restore`);
  return toFolder(res);
}

/** Hard-delete a folder and every member conversation + cloud workspace (彻底删除文件夹). */
export async function permanentDeleteFolder(id: string): Promise<void> {
  await api.delete(`/v1/folders/${id}/permanent`);
}

/** Safe relative segment under the default container (`~/Documents/AgentCore/<name>`). */
export function sanitizeFolderSubpath(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return cleaned || "project";
}

/** Local binding key; empty / null subpath collapse to the same slot. */
export function localFolderBindingKey(
  localRootId: string,
  localSubpath: string | null | undefined,
): string {
  return `${localRootId}\0${localSubpath || ""}`;
}

/**
 * Find a live local project by FS binding (cache-side reuse before create).
 * First match wins — when the list is created_at asc, that is the oldest row.
 */
export function findLocalFolderByBinding(
  folders: FolderMeta[],
  localRootId: string,
  localSubpath: string | null | undefined,
): FolderMeta | undefined {
  const key = localFolderBindingKey(localRootId, localSubpath);
  return folders.find(
    (f) =>
      f.mode === "local" &&
      !!f.localRootId &&
      localFolderBindingKey(f.localRootId, f.localSubpath) === key,
  );
}

/**
 * Dedupe local projects by binding for picker / list UIs; keep first occurrence
 * (grouped cache is created_at asc → oldest). Cloud rows are never collapsed.
 */
export function dedupeFoldersByLocalBinding(
  folders: FolderMeta[],
): FolderMeta[] {
  const seen = new Set<string>();
  const out: FolderMeta[] = [];
  for (const f of folders) {
    if (f.mode === "local" && f.localRootId) {
      const key = localFolderBindingKey(f.localRootId, f.localSubpath);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(f);
  }
  return out;
}
