import type { FileNode, FilePreviewResult, FileSource } from "@/lib/fileSource";
import {
  type MemoryKind,
  getMemoryFile,
  writeMemoryFile,
} from "@/services/memory";

/**
 * A {@link FileSource} over the user's long-term-memory **leaves**, so the「AI 记忆」rail
 * can reuse the same markdown editor host ({@link MarkdownFileEditor}) the file workbench
 * uses — full-text edit + preview + AI 改写 + CAS conflict handling, all for free
 * (Agent记忆与知识系统 §1.6).
 *
 * 记忆作用域与画像分层 P2: there is no longer ONE memory doc — the always-injected core is
 * split into 偏好 (global) + 画像 (global or per-project). Each leaf is one editable virtual
 * file addressed by a synthetic PATH that encodes (kind, scope):
 *
 *   global/preferences          → 偏好.md (global)
 *   global/profile              → 画像.md (global)
 *   project/<folderId>/profile  → 画像.md (that project's layer)
 *
 * The source is path-aware (the editor passes each tab's path to every call), so ONE
 * instance serves all leaves. tree / CRUD are never reached (the editor only calls
 * `readForEdit` / `writeText`), so they reject rather than pretend. `version.etag` carries
 * the per-file content hash — the editor sends it back as the write baseline, so an offline
 * consolidation that moved a leaf underneath surfaces as a conflict, never a silent clobber.
 */

/** The synthetic leaf path for the GLOBAL 偏好 (沟通/工作习惯). */
export const GLOBAL_PREFERENCES_PATH = "global/preferences";
/** The synthetic leaf path for the GLOBAL 画像 (技术栈/关于用户的事实). */
export const GLOBAL_PROFILE_PATH = "global/profile";

/** The synthetic leaf path for a project's 画像 (scope = its folderId). */
export function memoryProjectProfilePath(folderId: string): string {
  return `project/${folderId}/profile`;
}

interface MemoryLeaf {
  kind: MemoryKind;
  folderId: string | null;
}

const PROJECT_PROFILE_RE = /^project\/([^/]+)\/profile$/;

/** Parse a synthetic leaf path back to (kind, scope). Unknown → global 画像 (safe default). */
function parseLeaf(path: string): MemoryLeaf {
  if (path === GLOBAL_PREFERENCES_PATH)
    return { kind: "preferences", folderId: null };
  if (path === GLOBAL_PROFILE_PATH) return { kind: "profile", folderId: null };
  const m = PROJECT_PROFILE_RE.exec(path);
  if (m) return { kind: "profile", folderId: m[1] };
  return { kind: "profile", folderId: null };
}

/**
 * If `path` addresses a *project's* 画像 leaf, return its folderId, else null. Lets the
 * detail pane swap that one leaf for the two-pane 全局+本项目 editor while every other
 * memory leaf opens in the plain single-file editor.
 */
export function parseProjectProfilePath(path: string): string | null {
  const m = PROJECT_PROFILE_RE.exec(path);
  return m ? m[1] : null;
}

const unsupported = (): Promise<never> =>
  Promise.reject(new Error("记忆文档不支持该操作"));

export function createMemorySource(): FileSource {
  return {
    id: "memory",
    label: "AI 记忆",
    caps: { watch: false, transfer: false, edit: true, snapshots: false },
    listDir: (): Promise<FileNode[]> => Promise.resolve([]),
    read: async (path): Promise<FilePreviewResult> => {
      const leaf = parseLeaf(path);
      const doc = await getMemoryFile(leaf.kind, leaf.folderId);
      return { kind: "text", text: doc.content, truncated: false };
    },
    createFile: unsupported,
    mkdir: unsupported,
    move: unsupported,
    delete: unsupported,
    readForEdit: async (path) => {
      const leaf = parseLeaf(path);
      const doc = await getMemoryFile(leaf.kind, leaf.folderId);
      return {
        text: doc.content,
        version: { etag: doc.version },
        encoding: "utf-8",
        eol: "lf",
      };
    },
    writeText: async (path, input) => {
      const leaf = parseLeaf(path);
      const r = await writeMemoryFile(
        leaf.kind,
        input.content,
        input.baseline?.etag ?? null,
        leaf.folderId,
      );
      return r.ok
        ? { ok: true as const, version: { etag: r.version } }
        : {
            ok: false as const,
            reason: "conflict" as const,
            version: { etag: r.version },
          };
    },
  };
}
