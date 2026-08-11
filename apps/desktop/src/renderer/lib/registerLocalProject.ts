import { addFolderCache, getFolders } from "@/hooks/useFolders";
import {
  type LocalPickerFailureKind,
  localPickerFailureCopy,
  notifyLocalPickerFailure,
  pickLocalFolderRoot,
} from "@/lib/bindLocalFolder";
import { hasLocalFiles } from "@/lib/capabilities";
import { notifyError } from "@/lib/toast";
import { resolveSidecarAccountAuth } from "@/services/accountToken";
import {
  type FolderMeta,
  createFolder,
  findLocalFolderByBinding,
} from "@/services/folders";
import { useAuthStore } from "@/stores/auth";
import type { FsRoot } from "@shared/ipc-contract";

/** Answer text so the CEO sees which project was registered (same conversation). */
export function formatRegisterLocalProjectAnswer(
  optionLabel: string,
  folderName: string,
): string {
  return `${optionLabel}（${folderName} · 已登记为本地项目，仍在本对话）`;
}

export type PickAndRegisterLocalProjectResult =
  | { ok: true; root: FsRoot; folder: FolderMeta; created: boolean }
  | { ok: false; reason: "cancelled" }
  | {
      ok: false;
      reason: LocalPickerFailureKind;
      message: string;
    };

/**
 * OS folder picker → create/reuse local Folder (mode=local, empty subpath) →
 * stay on the **current** conversation (caller resumes the ask).
 *
 * Does **not** call {@link startNewConversation} and does **not** rewrite the
 * current session's ``folder_id``. Distinct from {@link pickAndOpenLocalProject}
 * (open as birthplace + new session).
 */
export async function pickAndRegisterLocalProject(opts?: {
  notifyOnFailure?: boolean;
}): Promise<PickAndRegisterLocalProjectResult> {
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
    const message = e instanceof Error ? e.message : "登记本地项目失败，请重试";
    if (notifyOnFailure) {
      notifyError(e, "登记本地项目失败");
    }
    return { ok: false, reason: "error", message };
  }
}
