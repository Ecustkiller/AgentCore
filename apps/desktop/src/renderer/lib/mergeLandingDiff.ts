/**
 * 云桌 → 合回落点 Diff（§7.6 / §6.2）：纯桌面、无 handoff job。
 *
 * 无 last-merge base 时：云有∩落点无 → clean；云有∩落点异 → conflict（默认留本地）；
 * 云有∩落点同 → applied。首刀不做「云删推落点删」。
 * 判定复用 `handoff-review`；写入走 workspaceOp，写前再 hash，禁静默覆盖。
 */

import {
  type HandoffApplySelection,
  type HandoffFileChange,
  type ReviewRow,
  buildReviewRows,
  buildSelections,
  classifyThreeWay,
} from "@/lib/handoff-review";
import JSZip from "jszip";

/** 与主进程 `WORKSPACE_READ_MAX` 对齐：超限诚实跳过，避免误判/OOM。 */
export const MERGE_LANDING_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** 单次合回最多扫描的云侧文件数（对齐列举帽量级）。 */
export const MERGE_LANDING_MAX_FILES = 5000;

/** 整包进渲染进程的硬顶（对齐 ARCHIVE_MAX_BYTES）；超限拒绝，禁无提示 OOM。 */
export const MERGE_LANDING_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;

const PREVIEW_CHARS = 64 * 1024;

export type CloudZipFile = {
  path: string;
  resultSha: string;
  sizeBytes: number;
  isBinary: boolean;
  /** UTF-8 预览（可截断）；二进制为 null。 */
  content: string | null;
  /** 写出用 base64。 */
  contentBase64: string;
};

export type ParseCloudZipResult = {
  files: CloudZipFile[];
  skippedOversized: string[];
  truncated: boolean;
};

export type MergeLandingApplyRow = {
  path: string;
  status: "applied" | "skipped" | "conflict" | "error";
  detail: string;
};

export type MergeLandingApplySummary = {
  results: MergeLandingApplyRow[];
  applied: number;
  skipped: number;
  conflicts: number;
  errors: number;
};

/** bytes → sha256 hex（Web Crypto）。 */
export async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  // DOM lib 要 ArrayBuffer 视图；Uint8Array 默认 buffer 为 ArrayBufferLike。
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function tryUtf8Preview(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return null;
    return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
  } catch {
    return null;
  }
}

/** 规范化 zip 条目路径；越界 / 空段返回 null。 */
export function normalizeZipPath(name: string): string | null {
  const path = name.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path) return null;
  const parts = path.split("/");
  if (parts.some((p) => p === ".." || p === "")) return null;
  return path;
}

/**
 * 内存解析云快照 zip → 文件表。过大单文件 / 超文件数诚实跳过或截断。
 */
export async function parseCloudZip(
  data: ArrayBuffer | Uint8Array,
): Promise<ParseCloudZipResult> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  const skippedOversized: string[] = [];
  const files: CloudZipFile[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (files.length >= MERGE_LANDING_MAX_FILES) {
      truncated = true;
      break;
    }
    const path = normalizeZipPath(entry.name);
    if (!path) continue;
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength > MERGE_LANDING_FILE_MAX_BYTES) {
      skippedOversized.push(path);
      continue;
    }
    const resultSha = await sha256HexFromBytes(bytes);
    const content = tryUtf8Preview(bytes);
    files.push({
      path,
      resultSha,
      sizeBytes: bytes.byteLength,
      isBinary: content === null,
      content,
      contentBase64: bytesToBase64(bytes),
    });
  }

  return { files, skippedOversized, truncated };
}

/**
 * 无 base：一律按「相对空基线的新增」喂给三方判定。
 * `changeType` 在读完 localSha 后修正为 added/modified。
 */
export function cloudFilesToChanges(
  files: CloudZipFile[],
  localShas: Map<string, string | null>,
): HandoffFileChange[] {
  return files.map((f) => {
    const localSha = localShas.get(f.path) ?? null;
    return {
      path: f.path,
      changeType: localSha === null ? "added" : "modified",
      baseSha: null,
      resultSha: f.resultSha,
      isBinary: f.isBinary,
      content: f.content,
      sizeBytes: f.sizeBytes,
    };
  });
}

export function buildMergeLandingRows(
  files: CloudZipFile[],
  localShas: Map<string, string | null>,
): ReviewRow[] {
  return buildReviewRows(cloudFilesToChanges(files, localShas), localShas);
}

/**
 * 写前复核：冲突且未显式 force → 拒绝；已一致 → 跳过。
 * `force` 仅来自「评审时已是冲突且选了云端」。
 */
export function gateMergeWrite(opts: {
  selection: HandoffApplySelection;
  resultSha: string | null;
  freshLocalSha: string | null;
}): "write" | "skip_applied" | "skip_local" | "conflict" {
  if (opts.selection.decision !== "cloud") return "skip_local";
  const fresh = classifyThreeWay(null, opts.resultSha, opts.freshLocalSha);
  if (fresh === "applied") return "skip_applied";
  if (fresh === "conflict" && !opts.selection.force) return "conflict";
  return "write";
}

export function bytesByPathFromFiles(
  files: CloudZipFile[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.path] = f.contentBase64;
  return out;
}

export function summarizeApply(
  results: MergeLandingApplyRow[],
): MergeLandingApplySummary {
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  let errors = 0;
  for (const r of results) {
    if (r.status === "applied") applied += 1;
    else if (r.status === "skipped") skipped += 1;
    else if (r.status === "conflict") conflicts += 1;
    else errors += 1;
  }
  return { results, applied, skipped, conflicts, errors };
}

/** 供单测：从评审行直接得到选择集（复用 handoff-review）。 */
export { buildSelections };
