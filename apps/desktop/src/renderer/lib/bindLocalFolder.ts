import {
  getConversations,
  patchConversationCache,
} from "@/hooks/useConversations";
import { patchConversationScratch } from "@/hooks/useWorkspaces";
import { hasLocalFiles } from "@/lib/capabilities";
import { ApiError } from "@/services/api";
import { bareConversationScratchSubpath } from "@/services/bareScratchPath";
import {
  type WorkspaceBinding,
  bindLocalWorkspace,
} from "@/services/workspaceBinding";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks";
import type { AddRootResult, FsRoot } from "@shared/ipc-contract";
import { toast } from "sonner";

/** Fired after a successful bind so composer / mode-bar chips can refresh. */
export const WORKSPACE_BINDING_CHANGED = "agentcore:workspace-binding-changed";

/** Answer text so the CEO/worker LLM sees which folder was bound. */
export function formatBindLocalFolderAnswer(
  optionLabel: string,
  folderName: string,
): string {
  return `${optionLabel}（${folderName}）`;
}

/**
 * Fixed local-picker failure kinds (B4 / aa51904b).
 * Cancel is silent — never show a card or 「已触发请选择」空转.
 */
export type LocalPickerFailureKind =
  | "dialog_failed"
  | "unauthorized"
  | "no_package_json"
  | "unavailable"
  | "error";

export type LocalPickerFailureCopy = {
  title: string;
  detail: string;
};

const LOCAL_PICKER_FAILURE_COPY: Record<
  LocalPickerFailureKind,
  LocalPickerFailureCopy
> = {
  dialog_failed: {
    title: "未弹出文件夹选择器",
    detail:
      "系统未能打开目录选择对话框。请确认窗口在前台后重试；不要连续空点「请选择」。",
  },
  unauthorized: {
    title: "未能授权本机目录",
    detail:
      "所选路径无法访问或未能登记为授权根。请换一个可访问的文件夹后重试。",
  },
  no_package_json: {
    title: "所选目录没有 package.json",
    detail:
      "请选择项目根目录（含 package.json 的文件夹），而不是空目录、压缩包解压不全的目录或上级目录。",
  },
  unavailable: {
    title: "本机目录仅桌面端可用",
    detail: "请在桌面客户端中打开本对话后再选择本机文件夹。",
  },
  error: {
    title: "本机目录操作失败",
    detail: "请重试；若反复失败，换一个文件夹或重启客户端。",
  },
};

export function localPickerFailureCopy(
  kind: LocalPickerFailureKind,
  message?: string,
): LocalPickerFailureCopy {
  const base = LOCAL_PICKER_FAILURE_COPY[kind];
  if (kind === "error" && message?.trim()) {
    return { title: base.title, detail: message.trim() };
  }
  if (
    (kind === "dialog_failed" || kind === "unauthorized") &&
    message?.trim()
  ) {
    return { title: base.title, detail: message.trim() };
  }
  return base;
}

export function isLocalPickerFailureKind(
  reason: string,
): reason is LocalPickerFailureKind {
  return (
    reason === "dialog_failed" ||
    reason === "unauthorized" ||
    reason === "no_package_json" ||
    reason === "unavailable" ||
    reason === "error"
  );
}

/** Toast for chip / palette paths (Ask 卡内另渲染固定结构化卡). */
export function notifyLocalPickerFailure(
  kind: LocalPickerFailureKind,
  message?: string,
): void {
  const { title, detail } = localPickerFailureCopy(kind, message);
  toast.error(title, { description: detail });
}

export type PickAndBindResult =
  | { ok: true; root: FsRoot; binding: WorkspaceBinding }
  | { ok: false; reason: "cancelled" }
  | {
      ok: false;
      reason: LocalPickerFailureKind;
      message: string;
    };

export type PickLocalFolderRootResult =
  | { ok: true; root: FsRoot }
  | { ok: false; reason: "cancelled" }
  | {
      ok: false;
      reason: Exclude<LocalPickerFailureKind, "no_package_json">;
      message: string;
    };

function describeBindError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return "对话不存在或无权访问";
  }
  return e instanceof Error ? e.message : "绑定失败，请重试";
}

function mapAddRootFailure(
  picked: Extract<AddRootResult, { ok: false }>,
): PickLocalFolderRootResult {
  if (picked.reason === "cancelled") {
    return { ok: false, reason: "cancelled" };
  }
  return {
    ok: false,
    reason: picked.reason,
    message: picked.message,
  };
}

/**
 * OS folder picker → authorize root → bind conversation **scratch** workspace
 * (``conversations/<id>``) for local execution. Not 「打开项目」—
 * see {@link pickAndOpenLocalProject} for Folder + new conversation.
 * Returns `cancelled` when the user dismisses the picker (caller must not resolve).
 */
export async function pickAndBindLocalFolder(
  conversationId: string,
): Promise<PickAndBindResult> {
  if (!hasLocalFiles() || !window.fsApi) {
    return {
      ok: false,
      reason: "unavailable",
      message: localPickerFailureCopy("unavailable").detail,
    };
  }
  try {
    const picked = await window.fsApi.addRoot();
    if (!picked.ok) {
      const mapped = mapAddRootFailure(picked);
      if (!mapped.ok && mapped.reason === "cancelled") {
        return { ok: false, reason: "cancelled" };
      }
      if (!mapped.ok) {
        return {
          ok: false,
          reason: mapped.reason,
          message: mapped.message,
        };
      }
      return { ok: false, reason: "cancelled" };
    }
    const root = picked.root;
    const binding = await bindLocalWorkspace(conversationId, root.id);
    if (binding.rootId) {
      const title =
        getConversations().find((c) => c.id === conversationId)?.title ??
        undefined;
      patchConversationScratch(conversationId, {
        ...(title ? { name: title } : {}),
        rootId: binding.rootId,
        location: "local",
        hasFiles: true,
        subpath: bareConversationScratchSubpath(conversationId),
      });
      patchConversationCache(conversationId, {
        localRootId: binding.rootId,
      });
    }
    useBackgroundTasksStore.setState((s) => ({
      modeByConversation: {
        ...s.modeByConversation,
        [conversationId]: binding.mode,
      },
      rootIdByConversation: {
        ...s.rootIdByConversation,
        [conversationId]: binding.rootId,
      },
    }));
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_BINDING_CHANGED, {
          detail: { conversationId },
        }),
      );
    }
    return { ok: true, root, binding };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: describeBindError(e),
    };
  }
}

/** Draft-only: authorize a folder without binding (no conversation yet). */
export async function pickLocalFolderRoot(): Promise<PickLocalFolderRootResult> {
  if (!hasLocalFiles() || !window.fsApi) {
    return {
      ok: false,
      reason: "unavailable",
      message: localPickerFailureCopy("unavailable").detail,
    };
  }
  try {
    const picked = await window.fsApi.addRoot();
    if (!picked.ok) return mapAddRootFailure(picked);
    return { ok: true, root: picked.root };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: e instanceof Error ? e.message : "选择本机目录失败，请重试",
    };
  }
}
