/** Cloud-folder helpers shared by the 文件 tab, 对话抽屉, and draft picker.
 *
 *  `ws_id` prefixes come from the workspaces list API (`folder:` / `conv:` / `shared:`).
 *  Draft folder is passed through router state so「在此新开」lands on `/` with the
 *  folder pre-selected — ChatPage reads it once; the user can still switch to 快速对话.
 */

export type WorkspaceKind = "folder" | "conv" | "shared" | "other";

export function workspaceKind(wsId: string): WorkspaceKind {
  if (wsId.startsWith("folder:")) return "folder";
  if (wsId.startsWith("conv:")) return "conv";
  if (wsId.startsWith("shared:")) return "shared";
  return "other";
}

export function folderWorkspaceId(folderId: string): string {
  return `folder:${folderId}`;
}

/** Router state for「在此文件夹中新开对话」→ draft home. */
export interface DraftFolderNavState {
  draftFolderId?: string;
  draftFolderName?: string;
}

export function readDraftFolderState(
  state: unknown,
): { id: string; name: string } | null {
  if (!state || typeof state !== "object") return null;
  const rec = state as DraftFolderNavState;
  const id = rec.draftFolderId?.trim();
  if (!id) return null;
  return { id, name: rec.draftFolderName?.trim() || "文件夹" };
}
