import { addFolderCache, getFolders } from "@/hooks/useFolders";
import {
  type LocalPickerFailureKind,
  localPickerFailureCopy,
  notifyLocalPickerFailure,
  pickLocalFolderRoot,
} from "@/lib/bindLocalFolder";
import { hasLocalFiles } from "@/lib/capabilities";
import { startNewConversation } from "@/lib/newConversation";
import { notifyError, notifySuccess } from "@/lib/toast";
import {
  type FolderMeta,
  createFolder,
  findLocalFolderByBinding,
} from "@/services/folders";
import type { FsRoot } from "@shared/ipc-contract";
import type { NavigateFunction } from "react-router-dom";

/** Answer text so the CEO/worker LLM sees which project was opened (new session). */
export function formatOpenLocalProjectAnswer(
  optionLabel: string,
  folderName: string,
): string {
  return `${optionLabel}（${folderName} · 已打开为本地项目，新会话）`;
}

export type PickAndOpenLocalProjectResult =
  | { ok: true; root: FsRoot; folder: FolderMeta; created: boolean }
  | { ok: false; reason: "cancelled" }
  | {
      ok: false;
      reason: LocalPickerFailureKind;
      message: string;
    };

async function rootHasPackageJson(rootId: string): Promise<boolean> {
  if (!window.fsApi) return false;
  const listed = await window.fsApi.listDir(rootId, "");
  if (!listed.ok) return false;
  return listed.data.some(
    (e) => e.kind === "file" && e.name === "package.json",
  );
}

/**
 * OS folder picker → create/reuse local Folder (mode=local, empty subpath) →
 * start a **new** conversation under that project.
 *
 * Does **not** rewrite the current session's ``folder_id`` (出生定终身).
 * Distinct from {@link pickAndBindLocalFolder} (bare-chat scratch execution bind).
 *
 * Failure kinds are fixed (dialog_failed / unauthorized / no_package_json / …);
 * callers should show the structured card — never loop 「已触发请选择」.
 */
export async function pickAndOpenLocalProject(
  navigate: NavigateFunction,
  opts?: { notifyOnFailure?: boolean },
): Promise<PickAndOpenLocalProjectResult> {
  const notifyOnFailure = opts?.notifyOnFailure !== false;
  if (!hasLocalFiles() || !window.fsApi) {
    const message = localPickerFailureCopy("unavailable").detail;
    if (notifyOnFailure) notifyLocalPickerFailure("unavailable", message);
    return { ok: false, reason: "unavailable", message };
  }
  try {
    const picked = await pickLocalFolderRoot();
    if (!picked.ok) {
      if (picked.reason === "cancelled") {
        return { ok: false, reason: "cancelled" };
      }
      if (notifyOnFailure) {
        notifyLocalPickerFailure(picked.reason, picked.message);
      }
      return {
        ok: false,
        reason: picked.reason,
        message: picked.message,
      };
    }

    const hasPkg = await rootHasPackageJson(picked.root.id);
    if (!hasPkg) {
      const message = localPickerFailureCopy("no_package_json").detail;
      if (notifyOnFailure) {
        notifyLocalPickerFailure("no_package_json", message);
      }
      return { ok: false, reason: "no_package_json", message };
    }

    const existing = findLocalFolderByBinding(
      getFolders(),
      picked.root.id,
      null,
    );
    let folder: FolderMeta;
    let created: boolean;
    if (existing) {
      folder = existing;
      created = false;
    } else {
      const result = await createFolder({
        name: picked.root.name,
        mode: "local",
        localRootId: picked.root.id,
        localSubpath: null,
      });
      folder = result.folder;
      created = result.created;
      addFolderCache(folder);
    }

    startNewConversation(navigate, folder.id);
    notifySuccess(
      created ? `已创建项目「${folder.name}」` : `已打开项目「${folder.name}」`,
    );
    return { ok: true, root: picked.root, folder, created };
  } catch (e) {
    const message = e instanceof Error ? e.message : "打开本地项目失败，请重试";
    if (notifyOnFailure) {
      notifyError(e, "打开本地项目失败");
    }
    return { ok: false, reason: "error", message };
  }
}
