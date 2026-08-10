// Document tree REST client for mobile (`/v1/documents`) — user rules carrier
// (Agent记忆与知识系统 §5.7 / §5.2). Mirrors desktop `services/documents.ts` over
// bearer-token `apiFetch`. 精简版 (手机端): GLOBAL scope only — list / create /
// edit / delete / apply_mode; per-project rules stay a desktop task (减法).
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];
type DocumentNodeWire = Schemas["DocumentNodeView"];
type DocumentDetailWire = Schemas["DocumentDetailView"];
type DocumentWriteWire = Schemas["DocumentWriteResult"];

/** Cloud-documents convention root name (§5.0). */
export const AGENTCORE_ROOT_NAME = "AgentCore";

/** User-rules directory under the convention root. */
export const RULES_DIR_NAME = "规则";

/**
 * User-facing injection mode for rules (§5.4). API also stores `conditional` for
 * scene rules; mobile only offers these two (no globs / conditions UI).
 */
export type DocumentApplyMode = "always" | "on_demand";

/** Map wire `apply_mode` onto the two-state UI (unknown / conditional → always). */
export function toApplyMode(raw: string): DocumentApplyMode {
  return raw === "on_demand" ? "on_demand" : "always";
}

/** A tree node's metadata (list rows — body omitted). */
export interface DocumentNode {
  id: string;
  parentId: string | null;
  /** Scope: null = GLOBAL layer, else the project (folder) this rule is bound to. */
  folderId: string | null;
  kind: "folder" | "document";
  role: "rule" | "general";
  aiMaintained: boolean;
  applyMode: DocumentApplyMode;
  name: string;
}

/** A node plus its markdown body + content-hash CAS tag. */
export interface DocumentDetail extends DocumentNode {
  content: string;
  version: string;
}

export interface DocumentWriteResult {
  ok: boolean;
  version: string;
  conflict: boolean;
}

/**
 * A failed documents REST call, carrying HTTP status so callers can tell a missing
 * endpoint (404/501 — 前后端版本漂移) apart from a transient failure.
 */
export class DocumentsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DocumentsApiError";
  }
}

/** Deployed backend lacks this endpoint (404/501) — calm「暂不可用」, don't retry. */
export function isDocumentsUnavailable(err: unknown): boolean {
  return (
    err instanceof DocumentsApiError &&
    (err.status === 404 || err.status === 501)
  );
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok)
    throw new DocumentsApiError(res.status, `${fallback} (${res.status})`);
  return (await res.json()) as T;
}

async function sendJson<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown | undefined,
  fallback: string,
): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok)
    throw new DocumentsApiError(res.status, `${fallback} (${res.status})`);
  return (await res.json()) as T;
}

const toNode = (w: DocumentNodeWire): DocumentNode => ({
  id: w.id,
  parentId: w.parent_id,
  folderId: w.folder_id,
  kind: w.kind === "folder" ? "folder" : "document",
  role: w.role === "rule" ? "rule" : "general",
  aiMaintained: w.ai_maintained,
  applyMode: toApplyMode(w.apply_mode),
  name: w.name,
});

const toDetail = (w: DocumentDetailWire): DocumentDetail => ({
  ...toNode(w),
  content: w.content,
  version: w.version,
});

function isUserRuleDoc(n: DocumentNode): boolean {
  return n.role === "rule" && !n.aiMaintained && n.kind === "document";
}

/** List a folder's direct children (`parentId` null = top-level). */
export function listDocuments(
  parentId: string | null = null,
): Promise<DocumentNode[]> {
  const q = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : "";
  return getJson<DocumentNodeWire[]>(`/v1/documents${q}`, "加载文档失败").then(
    (rows) => rows.map(toNode),
  );
}

/**
 * GLOBAL user rule documents (§5.2 / §5.0). Collects leaves under
 * `AgentCore/规则/` (folder_id null) plus leftover top-level GLOBAL rule docs.
 * Per-project rules are omitted (手机端减法 — manage on desktop).
 */
export async function listUserRules(): Promise<DocumentNode[]> {
  const tops = await listDocuments(null);
  const byId = new Map<string, DocumentNode>();

  for (const n of tops) {
    if (isUserRuleDoc(n) && n.folderId === null) byId.set(n.id, n);
  }

  const agentcores = tops.filter(
    (n) =>
      n.kind === "folder" &&
      n.name === AGENTCORE_ROOT_NAME &&
      n.folderId === null,
  );
  await Promise.all(
    agentcores.map(async (ac) => {
      const kids = await listDocuments(ac.id);
      const rulesDir = kids.find(
        (k) => k.kind === "folder" && k.name === RULES_DIR_NAME,
      );
      if (!rulesDir) return;
      const rules = await listDocuments(rulesDir.id);
      for (const n of rules) {
        if (isUserRuleDoc(n) && n.folderId === null) byId.set(n.id, n);
      }
    }),
  );

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** Load one document's body + CAS version. */
export function getDocument(id: string): Promise<DocumentDetail> {
  return getJson<DocumentDetailWire>(
    `/v1/documents/${encodeURIComponent(id)}`,
    "加载规则失败",
  ).then(toDetail);
}

/**
 * Create a GLOBAL user rule (`role=rule`, default `apply_mode=always`).
 * With `parent_id=null` the API auto-parents under `AgentCore/规则/` (§5.0).
 */
export function createRuleDocument(
  name: string,
  content = "",
): Promise<DocumentDetail> {
  return sendJson<DocumentDetailWire>(
    "/v1/documents",
    "POST",
    {
      name,
      kind: "document",
      role: "rule",
      content,
      parent_id: null,
      folder_id: null,
      apply_mode: "always",
    } satisfies Schemas["DocumentCreateRequest"],
    "新建规则失败",
  ).then(toDetail);
}

/** Switch a rule's injection mode (`always` ↔ `on_demand`). */
export function updateDocumentApplyMode(
  id: string,
  applyMode: DocumentApplyMode,
): Promise<DocumentNode> {
  return sendJson<DocumentDetailWire>(
    `/v1/documents/${encodeURIComponent(id)}`,
    "PATCH",
    {
      apply_mode: applyMode,
      reparent: false,
    } satisfies Schemas["DocumentPatchRequest"],
    "切换应用方式失败",
  ).then(toNode);
}

/** Overwrite a document's body (full-text, CAS-guarded). */
export function writeDocument(
  id: string,
  content: string,
  baseline: string | null,
): Promise<DocumentWriteResult> {
  return sendJson<DocumentWriteWire>(
    `/v1/documents/${encodeURIComponent(id)}`,
    "PUT",
    { content, baseline },
    "保存规则失败",
  );
}

/** Rename a document (content untouched). */
export function renameDocument(
  id: string,
  name: string,
): Promise<DocumentNode> {
  return sendJson<DocumentDetailWire>(
    `/v1/documents/${encodeURIComponent(id)}`,
    "PATCH",
    {
      name,
      reparent: false,
    } satisfies Schemas["DocumentPatchRequest"],
    "重命名失败",
  ).then(toNode);
}

/** Soft-delete a document. */
export function deleteDocument(id: string): Promise<DocumentWriteResult> {
  return sendJson<DocumentWriteWire>(
    `/v1/documents/${encodeURIComponent(id)}`,
    "DELETE",
    undefined,
    "删除规则失败",
  );
}
