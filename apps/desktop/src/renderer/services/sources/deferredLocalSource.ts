import type {
  FileEditDoc,
  FileNode,
  FilePreviewResult,
  FileSource,
  WriteTextResult,
} from "@/lib/fileSource";
import {
  type FolderMeta,
  promoteConversationWorkspace,
} from "@/services/folders";
import { applyConversationPromotion } from "@/services/workspacePromotion";
import { createLocalRootSource } from "./localRootSource";

/**
 * A {@link FileSource} for a **desktop 裸聊 with local intent** that has not produced a
 * file yet — the client-side mirror of the server's ``DeferredWorkspace`` (工作区对称化
 * D1a).
 *
 * Why this exists: a 裸聊's panel can't write a *local* workspace over the cloud REST
 * file routes (they're server-backed; a local write must go through desktop IPC). Yet
 * the conversation's stored intent (``local_container_root_id``) says its first file
 * should land *locally*. So instead of the cloud source (which would mint a local
 * folder server-side and strand the bytes there — the very split-brain this fixes),
 * the panel uses this: empty until the first **mutating** op, which lazily
 *
 *   1. promotes the 裸聊 (``POST …/workspace/promote`` → mints the local folder + a
 *      per-conversation subpath, decided by the conversation's intent),
 *   2. applies the same cache patches the ``workspace_promoted`` SSE event would
 *      (re-group the chat + surface the card), so the panel re-resolves to the real
 *      {@link createLocalRootSource} on the next render, and
 *   3. delegates the op to that local IPC source.
 *
 * Reads stay empty (a 裸聊 has no files) and never trigger promotion — only a write
 * does, matching the server's "promote on first file write" rule. Caps mirror the
 * local source so the toolbar doesn't flicker its affordances across the switch.
 */
export function createDeferredLocalSource(
  conversationId: string,
  containerRootId: string,
  label: string,
): FileSource {
  let inner: FileSource | null = null;
  let promoting: Promise<FileSource> | null = null;

  // Promote once (guarded against concurrent writes), then build + cache the real
  // local IPC source over the minted root + subpath. Subsequent ops reuse `inner`.
  const ensureInner = async (): Promise<FileSource> => {
    if (inner) return inner;
    if (promoting) return promoting;
    promoting = (async () => {
      const folder: FolderMeta =
        await promoteConversationWorkspace(conversationId);
      applyConversationPromotion(conversationId, folder);
      // The promote endpoint decides locality from the conversation's intent; for a
      // local-intent 裸聊 it returns the bound root + subpath. Fall back to the known
      // container root if the field is somehow absent (defensive — they match).
      const rootId = folder.localRootId ?? containerRootId;
      inner = createLocalRootSource(
        rootId,
        folder.name || label,
        folder.localSubpath,
      );
      return inner;
    })();
    try {
      return await promoting;
    } finally {
      promoting = null;
    }
  };

  return {
    id: `deferred-local:${conversationId}`,
    label,
    // Mirror the local source so the panel toolbar is stable across promotion: no
    // byte transfer (files are on disk), no cloud snapshots, but watch + edit.
    caps: { watch: true, transfer: false, edit: true, snapshots: false },
    async listDir(dir): Promise<FileNode[]> {
      // Pre-promotion a 裸聊 has no files; listing must not mint a workspace.
      return inner ? inner.listDir(dir) : [];
    },
    async listFileIndex(): Promise<string[]> {
      return inner?.listFileIndex ? inner.listFileIndex() : [];
    },
    async read(path): Promise<FilePreviewResult> {
      // A read implies the file exists, i.e. we've already promoted; reading must not
      // itself promote (only a write does). Pre-promotion there's nothing to read.
      if (!inner) throw new Error("文件不存在");
      return inner.read(path);
    },
    async readForEdit(path): Promise<FileEditDoc> {
      if (!inner) throw new Error("文件不存在");
      if (!inner.readForEdit) throw new Error("不支持编辑");
      return inner.readForEdit(path);
    },
    async writeText(path, input): Promise<WriteTextResult> {
      const src = await ensureInner();
      if (!src.writeText) {
        return { ok: false, reason: "unsupported", message: "不支持写入" };
      }
      return src.writeText(path, input);
    },
    async createFile(path): Promise<void> {
      await (await ensureInner()).createFile(path);
    },
    async mkdir(path): Promise<void> {
      await (await ensureInner()).mkdir(path);
    },
    async move(src, dst): Promise<void> {
      await (await ensureInner()).move(src, dst);
    },
    async copy(src, dst): Promise<void> {
      // copy 蕴含「源已存在」→ 必已 promote；故不经 ensureInner 触发 promote（呼应 read）。
      if (!inner) throw new Error("文件不存在");
      if (!inner.copy) throw new Error("不支持复制");
      return inner.copy(src, dst);
    },
    async delete(path): Promise<void> {
      await (await ensureInner()).delete(path);
    },
    watch(dir, onChange) {
      // Nothing on disk until promoted; the panel re-resolves to the real local
      // source (with a live watch) the render after the first write promotes.
      return inner?.watch ? inner.watch(dir, onChange) : () => {};
    },
  };
}
