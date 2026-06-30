// Long-term AI memory REST client for mobile (Agent记忆与知识系统 §一).
//
// Mirrors the desktop `services/memory.ts` contract, but over the bearer-token
// `apiFetch` (mobile has no cookie origin). 精简版 (手机端): GLOBAL scope only — no
// per-project layer, no AI 改写 / preview. The phone is a 查看 + 改 + 删 lens on the
// always-injected core (偏好 全局 + 画像 全局) and the on-demand 主题 notes, plus the
// master switch. The contract mirrors the workspace edit contract: full text + a
// content-addressed `version` baseline the next write does its CAS against.
import { apiFetch } from "@/api/client";

export interface MemoryDoc {
  content: string;
  /** Content-addressed CAS tag; sent back as the write baseline (stale → conflict). */
  version: string;
  enabled: boolean;
}

export interface MemoryFileDoc {
  content: string;
  /** Per-file content hash; sent back as the write baseline (stale → conflict). */
  version: string;
}

export interface MemoryWriteResult {
  ok: boolean;
  version: string;
  conflict: boolean;
}

/**
 * A single always-injected memory leaf: 偏好 (preferences, global-only) and 画像
 * (profile). The mobile lite surface edits the GLOBAL layer of each.
 */
export type MemoryKind = "preferences" | "profile";

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`${fallback} (${res.status})`);
  return (await res.json()) as T;
}

async function putJson<T>(
  path: string,
  body: unknown,
  fallback: string,
): Promise<T> {
  const res = await apiFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fallback} (${res.status})`);
  return (await res.json()) as T;
}

/** Load the master switch (the whole-doc body/version ride along, unused by the lite UI). */
export function getMemory(): Promise<MemoryDoc> {
  return getJson<MemoryDoc>("/v1/users/me/memory", "加载记忆失败");
}

/** Flip the long-term memory master switch (off = stop injecting AND growing). */
export function setMemoryEnabled(enabled: boolean): Promise<MemoryDoc> {
  return putJson<MemoryDoc>(
    "/v1/users/me/memory/enabled",
    { enabled },
    "设置失败",
  );
}

/** Load one always-injected core leaf (偏好 / 画像), GLOBAL layer. */
export function getMemoryFile(kind: MemoryKind): Promise<MemoryFileDoc> {
  return getJson<MemoryFileDoc>(
    `/v1/users/me/memory/files/${kind}`,
    "加载失败",
  );
}

/**
 * Write one core leaf back (full-text, CAS-guarded). Empty `content` clears the leaf.
 * A `baseline` that no longer matches returns `{ ok: false, conflict: true }`.
 */
export function writeMemoryFile(
  kind: MemoryKind,
  content: string,
  baseline: string | null,
): Promise<MemoryWriteResult> {
  return putJson<MemoryWriteResult>(
    `/v1/users/me/memory/files/${kind}`,
    { content, baseline },
    "保存失败",
  );
}

/** GLOBAL 主题 note slugs (on-demand notes the agent pulls via consult_memory). */
export function listMemoryTopics(): Promise<string[]> {
  return getJson<{ topics: string[] }>(
    "/v1/users/me/memory/topics",
    "加载主题失败",
  ).then((r) => r.topics);
}

/** Load one GLOBAL 主题 note's body (+ CAS version). */
export function getMemoryTopic(slug: string): Promise<MemoryFileDoc> {
  return getJson<MemoryFileDoc>(
    `/v1/users/me/memory/topics/${encodeURIComponent(slug)}`,
    "加载主题失败",
  );
}

/**
 * Write one 主题 note back (full-text, CAS-guarded). Empty `content` deletes the note.
 * A `baseline` that no longer matches returns `{ ok: false, conflict: true }`.
 */
export function writeMemoryTopic(
  slug: string,
  content: string,
  baseline: string | null,
): Promise<MemoryWriteResult> {
  return putJson<MemoryWriteResult>(
    `/v1/users/me/memory/topics/${encodeURIComponent(slug)}`,
    { content, baseline },
    "保存失败",
  );
}
