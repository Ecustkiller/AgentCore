import { addFolderCache, getFolders } from "@/hooks/useFolders";
import {
  type LocalPickerFailureKind,
  localPickerFailureCopy,
  notifyLocalPickerFailure,
  pickLocalFolderRoot,
} from "@/lib/bindLocalFolder";
import { hasLocalFiles } from "@/lib/capabilities";
import { startNewConversation } from "@/lib/newConversation";
import { notifyError } from "@/lib/toast";
import { resolveSidecarAccountAuth } from "@/services/accountToken";
import {
  type FolderMeta,
  createFolder,
  findLocalFolderByBinding,
} from "@/services/folders";
import { useAuthStore } from "@/stores/auth";
import type { FsRoot } from "@shared/ipc-contract";
import type { NavigateFunction } from "react-router-dom";

/** Answer text so the CEO/worker LLM sees which folder was opened (new session). */
export function formatOpenLocalFolderAnswer(
  optionLabel: string,
  folderName: string,
): string {
  return `${optionLabel}（${folderName} · 已打开为本机文件夹，新会话）`;
}

export type PickAndOpenLocalFolderResult =
  | { ok: true; root: FsRoot; folder: FolderMeta; created: boolean }
  | { ok: false; reason: "cancelled" }
  | {
      ok: false;
      reason: LocalPickerFailureKind;
      message: string;
    };

/**
 * OS folder picker → create/reuse local Folder (mode=local, empty subpath) →
 * start a **new** conversation under that folder.「打开本机文件夹」is one of the
 * two ways to get a container at all (双模式工作区 §5.4).
 *
 * Does **not** rewrite the current session's ``folder_id`` (出生定终身).
 * Distinct from {@link pickAndBindLocalFolder} (bare-chat scratch execution bind).
 *
 * Failure kinds are fixed (dialog_failed / unauthorized / …);
 * callers should show the structured card — never loop 「已触发请选择」.
 * No language-specific root marker (e.g. package.json) — any folder qualifies.
 */
export async function pickAndOpenLocalFolder(
  navigate: NavigateFunction,
  opts?: { notifyOnFailure?: boolean },
): Promise<PickAndOpenLocalFolderResult> {
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
    // Silent Cursor-style index + MCP + rules/memory warm: ensure sidecar (fire-and-forget).
    if (window.sidecarApi?.warmCodeIndex) {
      void window.sidecarApi
        .warmCodeIndex({ rootId: picked.root.id, subpath: "" })
        .catch(() => {
          /* best-effort; no toast */
        });
    }
    if (window.sidecarApi?.warmMcpDiscover) {
      void window.sidecarApi
        .warmMcpDiscover({
          rootId: picked.root.id,
          subpath: "",
          userId: useAuthStore.getState().user?.id,
        })
        .catch(() => {
          /* best-effort; no toast */
        });
    }
    if (window.sidecarApi?.warmAccountRulesMemory) {
      void (async () => {
        const accountAuth = (await resolveSidecarAccountAuth()) ?? undefined;
        if (!accountAuth) return;
        await window.sidecarApi?.warmAccountRulesMemory({
          rootId: picked.root.id,
          subpath: "",
          folderId: folder.id,
          accountAuth,
          userId: useAuthStore.getState().user?.id,
        });
      })().catch(() => {
        /* best-effort; no toast */
      });
    }
    return { ok: true, root: picked.root, folder, created };
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "打开本机文件夹失败，请重试";
    if (notifyOnFailure) {
      notifyError(e, "打开本机文件夹失败");
    }
    return { ok: false, reason: "error", message };
  }
}
