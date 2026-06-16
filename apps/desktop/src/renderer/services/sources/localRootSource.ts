import {
  type FileNode,
  type FilePreviewResult,
  type FileSource,
  baseName,
  parentDir,
} from "@/lib/fileSource";
import type { FilePreview as LocalPreview } from "@shared/ipc-contract";

/** Map the local IPC preview shape into the unified result. */
function adaptPreview(p: LocalPreview): FilePreviewResult {
  if (p.kind === "text") {
    return { kind: "text", text: p.content, truncated: p.truncated };
  }
  if (p.kind === "image") {
    return { kind: "image", dataUrl: p.dataUrl, mime: p.mime, size: p.size };
  }
  return { kind: "binary", mime: p.mime, size: p.size, reason: p.reason };
}

/**
 * A {@link FileSource} over an authorized local OS root (desktop IPC,
 * `window.fsApi`).
 *
 * Native lazy per-directory listing + live watch; no byte transfer (files are
 * already on disk) and no snapshots/handoff (those are workspace concerns). The
 * local IPC splits "rename in place" (a bare new name) from "move into a
 * directory", so the unified full-destination `move` is translated back to
 * whichever the IPC expresses; a simultaneous move+rename isn't expressible in
 * one call today and is rejected (the tree never issues that pair).
 */
export function createLocalRootSource(
  rootId: string,
  label: string,
): FileSource {
  return {
    id: `local:${rootId}`,
    label,
    caps: {
      watch: true,
      transfer: false,
      edit: false,
      snapshots: false,
      handoff: false,
    },
    async listDir(dir) {
      const res = await window.fsApi.listDir(rootId, dir);
      if (!res.ok) throw new Error(res.reason);
      return res.data.map(
        (e): FileNode => ({
          path: e.relPath,
          name: e.name,
          isDir: e.kind === "dir",
        }),
      );
    },
    async listFileIndex() {
      // Flat file list for the @ index (文件中枢统一 F4); the IPC already prunes
      // node_modules/.git… and caps the count, matching the cloud /file-index.
      const res = await window.fsApi.listFiles(rootId);
      if (!res.ok) throw new Error(res.reason);
      return res.data.map((f) => f.relPath);
    },
    async read(path): Promise<FilePreviewResult> {
      const res = await window.fsApi.readFile(rootId, path);
      if (!res.ok) throw new Error(res.reason);
      return adaptPreview(res.data);
    },
    async createFile(path) {
      const res = await window.fsApi.create(rootId, path, "file");
      if (!res.ok) throw new Error(res.reason);
    },
    async mkdir(path) {
      const res = await window.fsApi.create(rootId, path, "dir");
      if (!res.ok) throw new Error(res.reason);
    },
    async move(src, dst) {
      const sameParent = parentDir(src) === parentDir(dst);
      const sameName = baseName(src) === baseName(dst);
      if (sameParent && sameName) return;
      if (sameParent) {
        const res = await window.fsApi.rename(rootId, src, baseName(dst));
        if (!res.ok) throw new Error(res.reason);
        return;
      }
      if (sameName) {
        const res = await window.fsApi.move(rootId, src, parentDir(dst));
        if (!res.ok) throw new Error(res.reason);
        return;
      }
      throw new Error("暂不支持同时移动并改名");
    },
    async delete(path) {
      const res = await window.fsApi.delete(rootId, path);
      if (!res.ok) throw new Error(res.reason);
    },
    watch(dir, onChange) {
      void window.fsApi.watch(rootId, dir);
      const off = window.fsApi.onChanged((e) => {
        if (e.rootId === rootId && e.relPath === dir) onChange(dir);
      });
      return () => {
        void window.fsApi.unwatch(rootId, dir);
        off();
      };
    },
  };
}
