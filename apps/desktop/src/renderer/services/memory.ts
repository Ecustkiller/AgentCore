import { api } from "@/services/api";

/**
 * Long-term AI memory REST client (`/v1/users/me/memory`).
 *
 * The user's memory is the markdown body of their `ai_maintained` rule file
 * (Agent记忆与知识系统). It is edited through the same source-agnostic markdown editor
 * the file workbench uses (see `services/sources/memorySource`), so the contract
 * mirrors the workspace edit contract: full text + a content-addressed `version`
 * baseline the next write does its CAS against. `enabled` is the master switch.
 */

export interface MemoryDoc {
  content: string;
  /** Content-addressed CAS tag; sent back as the write baseline (stale → conflict). */
  version: string;
  enabled: boolean;
}

export interface MemoryWriteResult {
  ok: boolean;
  version: string;
  conflict: boolean;
}

/** Load the memory document + whether memory is enabled. */
export function getMemory(): Promise<MemoryDoc> {
  return api.get<MemoryDoc>("/v1/users/me/memory");
}

/**
 * Write the memory body back (full-document edit). `baseline` is the version the
 * edit was based on; `null` writes unconditionally (清空 / 仍然覆盖). A baseline that
 * no longer matches returns `{ ok: false, conflict: true }` with the live version.
 */
export function writeMemory(
  content: string,
  baseline: string | null,
): Promise<MemoryWriteResult> {
  return api.put<MemoryWriteResult>("/v1/users/me/memory", {
    content,
    baseline,
  });
}

/** Flip the long-term memory master switch (off = stop injecting AND growing). */
export function setMemoryEnabled(enabled: boolean): Promise<MemoryDoc> {
  return api.put<MemoryDoc>("/v1/users/me/memory/enabled", { enabled });
}

/**
 * A single memory *leaf* (Agent记忆与知识系统 §1.4). The always-injected core is split into
 * 偏好 (`preferences`, GLOBAL-only) + 画像 (`profile`, global or per-project), each its own
 * editable file. `profile` takes an optional `folderId` to address a project's layer.
 */
export type MemoryKind = "preferences" | "profile";

export interface MemoryFileDoc {
  content: string;
  /** Per-file content hash; sent back as the write baseline (stale → conflict). */
  version: string;
}

const memoryFilePath = (kind: MemoryKind, folderId: string | null): string =>
  folderId
    ? `/v1/users/me/memory/files/${kind}?folder_id=${encodeURIComponent(folderId)}`
    : `/v1/users/me/memory/files/${kind}`;

/** Load one memory leaf — 偏好/画像 (global) or a project's 画像 (with `folderId`). */
export function getMemoryFile(
  kind: MemoryKind,
  folderId: string | null = null,
): Promise<MemoryFileDoc> {
  return api.get<MemoryFileDoc>(memoryFilePath(kind, folderId));
}

/**
 * Write one memory leaf back (full-text, CAS-guarded). Empty `content` clears (drops) the
 * leaf. A `baseline` that no longer matches returns `{ ok: false, conflict: true }`.
 */
export function writeMemoryFile(
  kind: MemoryKind,
  content: string,
  baseline: string | null,
  folderId: string | null = null,
): Promise<MemoryWriteResult> {
  return api.put<MemoryWriteResult>(memoryFilePath(kind, folderId), {
    content,
    baseline,
  });
}

/** folder_ids that have project-scoped memory — the rail shows a「本项目记忆」node each. */
export function listMemoryProjects(): Promise<string[]> {
  return api
    .get<{ folders: string[] }>("/v1/users/me/memory/projects")
    .then((r) => r.folders);
}

/**
 * On-demand TOPIC notes (``主题/<slug>.md``) live alongside the always-injected core: the
 * agent pulls them via `consult_memory`, and the「文件」rail's 主题/ folder browses them.
 * `folderId` null = the GLOBAL 主题/ folder, else that project's (same scope convention as
 * the per-leaf surface). Names only ride the listing; a note's body is pulled per-open.
 */
export function listMemoryTopics(
  folderId: string | null = null,
): Promise<string[]> {
  const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : "";
  return api
    .get<{ topics: string[] }>(`/v1/users/me/memory/topics${q}`)
    .then((r) => r.topics);
}

const memoryTopicApiPath = (slug: string, folderId: string | null): string => {
  const base = `/v1/users/me/memory/topics/${encodeURIComponent(slug)}`;
  return folderId ? `${base}?folder_id=${encodeURIComponent(folderId)}` : base;
};

/** Load one TOPIC note's body (+ CAS version), in the global or a project's 主题/ folder. */
export function getMemoryTopic(
  slug: string,
  folderId: string | null = null,
): Promise<MemoryFileDoc> {
  return api.get<MemoryFileDoc>(memoryTopicApiPath(slug, folderId));
}

/**
 * Write one TOPIC note back (full-text, CAS-guarded). Empty `content` clears (drops) the
 * note. A `baseline` that no longer matches returns `{ ok: false, conflict: true }`.
 */
export function writeMemoryTopic(
  slug: string,
  content: string,
  baseline: string | null,
  folderId: string | null = null,
): Promise<MemoryWriteResult> {
  return api.put<MemoryWriteResult>(memoryTopicApiPath(slug, folderId), {
    content,
    baseline,
  });
}
