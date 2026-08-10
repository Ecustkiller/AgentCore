import { LOCAL_TRADITIONAL_LABEL } from "@/lib/conversationWorkspaceMode";
import type { WorkspaceBinding } from "@/services/workspaceBinding";
import { isBoundRootMissing } from "@/services/workspaceBinding";
import type { FsRoot } from "@shared/ipc-contract";

/**
 * Effective workspace location for UI chips / mode bars.
 *
 * Turn routing uses `local_root_id` **or** `local_container_root_id` (sidecar /
 * cloud-turn binding). Project conversations inherit the folder bind
 * (`scope=folder`); bare chats use conversation bind or default container.
 */
export interface EffectiveWorkspace {
  /** True when turns route to a local root (bound folder or default container). */
  isLocal: boolean;
  /** Root id used for display / missing-root checks (bound root preferred). */
  rootId: string | null;
  /** Human folder name when resolvable from the desktop root list. */
  rootName: string | null;
  /** Explicit bind whose root is gone on this device (§八). */
  rootMissing: boolean;
  /** True when locality comes from default container, not an explicit bind. */
  viaContainer: boolean;
  /** Project name when the conversation inherits a folder workspace. */
  projectName: string | null;
  /** Binding lives on the project (vs bare conversation scratch). */
  viaProject: boolean;
}

export function resolveEffectiveWorkspace(opts: {
  binding: WorkspaceBinding | null;
  localContainerRootId: string | null | undefined;
  roots: readonly FsRoot[];
  projectName?: string | null;
}): EffectiveWorkspace {
  const { binding, localContainerRootId, roots, projectName = null } = opts;
  const viaProject = binding?.scope === "folder";
  const boundRootId =
    binding?.mode === "local" && binding.rootId ? binding.rootId : null;

  if (boundRootId) {
    const rootName = roots.find((r) => r.id === boundRootId)?.name ?? null;
    return {
      isLocal: true,
      rootId: boundRootId,
      rootName,
      rootMissing: isBoundRootMissing(binding, roots),
      viaContainer: binding?.source === "container",
      projectName: viaProject ? projectName : null,
      viaProject,
    };
  }

  if (localContainerRootId) {
    const rootName =
      roots.find((r) => r.id === localContainerRootId)?.name ?? null;
    return {
      isLocal: true,
      rootId: localContainerRootId,
      rootName,
      rootMissing: !roots.some((r) => r.id === localContainerRootId),
      viaContainer: true,
      projectName: null,
      viaProject: false,
    };
  }

  return {
    isLocal: false,
    rootId: null,
    rootName: null,
    rootMissing: false,
    viaContainer: false,
    projectName: viaProject ? projectName : null,
    viaProject,
  };
}

/**
 * Chip / mode-bar label（可见短标；「· 本机传统」= 工作区文件夹绑定，≠ 执行引擎）:
 * - project local: 「项目名 · 本机传统」
 * - project cloud: 「项目名 · 云端对话」
 * - bare local: 「本机草稿」
 * - bare cloud（已建会话）: 「云端对话」（草稿 chip 仍用「快速对话」）
 */
export function formatWorkspaceChipLabel(ws: EffectiveWorkspace): string {
  if (ws.viaProject && ws.projectName) {
    return ws.isLocal
      ? `${ws.projectName} · ${LOCAL_TRADITIONAL_LABEL}`
      : `${ws.projectName} · 云端对话`;
  }
  if (ws.isLocal) return "本机草稿";
  return "云端对话";
}

/**
 * Bound workspace chip `title` / `aria-label`：与可见「· 本机传统」配套，说清是工作区绑定
 * （文件夹绑定，≠ 执行路径）。执行路径不在大众 Composer 产品面展示。
 */
export function formatWorkspaceChipTitle(ws: EffectiveWorkspace): string {
  if (ws.viaProject) {
    return ws.isLocal
      ? `${LOCAL_TRADITIONAL_LABEL}（本机文件夹权威，≠离线）`
      : "云端对话";
  }
  return ws.isLocal ? "本机草稿（文件落本机默认目录，不算项目）" : "云端对话";
}
