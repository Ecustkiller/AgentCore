import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import type { IndexedEntry } from "@/lib/fileIndex";
import type { DraftWorkspaceIntent } from "@/stores/folders";
import { posixRel } from "@shared/citeWorkspacePath";

const WORKSPACE_FOLDER_PREFIX = "workspace:folder:";

export type AttachmentFolderHint = {
  folderId: string;
  folderName: string;
};

/**
 * 文件相对某授权根：挑覆盖它的本机文件夹（最长 ``localSubpath`` 前缀）。
 * 无登记根 / 文件落在所有子路径外 → null。
 */
export function resolveFolderFromCitedRoot(
  rootId: string,
  relPath: string,
): AttachmentFolderHint | null {
  const rel = posixRel(relPath);
  let best: { hint: AttachmentFolderHint; score: number } | null = null;
  for (const f of getFolders()) {
    if (f.mode !== "local" || f.localRootId !== rootId) continue;
    const sub = posixRel(f.localSubpath ?? "");
    if (!sub) {
      if (!best)
        best = { hint: { folderId: f.id, folderName: f.name }, score: 0 };
      continue;
    }
    if (rel !== sub && !rel.startsWith(`${sub}/`)) continue;
    const score = sub.length;
    if (!best || score > best.score) {
      best = { hint: { folderId: f.id, folderName: f.name }, score };
    }
  }
  return best?.hint ?? null;
}

export type DraftFolderAssignDecision =
  | { action: "auto"; folderId: string; folderName: string }
  | { action: "prompt"; folderId: string; folderName: string }
  | { action: "none" };

/** 草稿尚未选定文件夹 → 跟附件来源；已是另一文件夹 → 冲突条。 */
export function decideDraftFolderAssign(
  hint: AttachmentFolderHint,
  intent: DraftWorkspaceIntent,
): DraftFolderAssignDecision {
  if (intent.kind === "folder") {
    if (intent.folderId === hint.folderId) return { action: "none" };
    return {
      action: "prompt",
      folderId: hint.folderId,
      folderName: hint.folderName,
    };
  }
  return {
    action: "auto",
    folderId: hint.folderId,
    folderName: hint.folderName,
  };
}

/**
 * Infer a folder (project) id from an @-mention / browse attachment entry.
 * Returns null when the entry has no mappable project (e.g. bare local root).
 */
/** Folder-relative POSIX path for a file cited from ``hint``. */
export function workspaceRelOnHintFolder(
  hint: AttachmentFolderHint,
  containerRel: string,
): string {
  const folder = getFolders().find((f) => f.id === hint.folderId);
  const sub = posixRel(folder?.localSubpath ?? "");
  const rel = posixRel(containerRel);
  if (sub && (rel === sub || rel.startsWith(`${sub}/`))) {
    return rel === sub ? "." : rel.slice(sub.length + 1);
  }
  return rel;
}

/**
 * Other-desk Folder id for this-turn live-file cite, or undefined when the
 * file already sits on this conversation's desk.
 */
export function otherDeskFolderId(
  conversationId: string | null,
  hint: AttachmentFolderHint | null,
): string | undefined {
  if (!hint?.folderId) return undefined;
  if (!conversationId) return hint.folderId;
  const sitting = getConversations().find(
    (c) => c.id === conversationId,
  )?.folderId;
  if (typeof sitting === "string" && sitting && sitting === hint.folderId) {
    return undefined;
  }
  return hint.folderId;
}

export function resolveFolderFromIndexedEntry(
  entry: IndexedEntry,
): AttachmentFolderHint | null {
  if (entry.kind === "document") return null;

  if (entry.kind === "conversation") {
    const conv = getConversations().find((c) => c.id === entry.relPath);
    if (!conv?.folderId) return null;
    const folder = getFolders().find((f) => f.id === conv.folderId);
    return folder
      ? { folderId: folder.id, folderName: folder.name }
      : { folderId: conv.folderId, folderName: entry.name };
  }

  if (entry.sourceId.startsWith(WORKSPACE_FOLDER_PREFIX)) {
    const folderId = entry.sourceId.slice(WORKSPACE_FOLDER_PREFIX.length);
    if (!folderId) return null;
    const folder = getFolders().find((f) => f.id === folderId);
    return folder
      ? { folderId: folder.id, folderName: folder.name }
      : { folderId, folderName: entry.sourceLabel };
  }

  const localMatch = /^local:([^:]+)(?::(.*))?$/.exec(entry.sourceId);
  if (localMatch) {
    const rootId = localMatch[1];
    const subBase = (localMatch[2] || "").replace(/^\/+|\/+$/g, "");
    const containerRel = subBase
      ? `${subBase}/${entry.relPath}`.replace(/\/+/g, "/")
      : entry.relPath;
    return resolveFolderFromCitedRoot(rootId, containerRel);
  }

  return null;
}
