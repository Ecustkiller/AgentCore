// 产出卡文件行元信息：按路径向已有工作区 list 取 size/mtime（不改 DeliveryArtifact / 不新造 list）。
// 对不上或缺字段就空着。列表行只画修改时间；sizeBytes 仍随 list 带回，不在行上显示。

import { fileMetaByPath, listWorkspaceFiles } from "@/api/workspace";
import { listWorkspaceFilesByWs } from "@/api/workspaces";
import type { FileArtifact } from "@/lib/fileArtifacts";

export type FileListingMeta = { sizeBytes?: number; mtimeMs?: number };

export type ListingDesk = { kind: "conv" | "ws"; id: string };

export function listingDeskKey(
  artifact: FileArtifact,
  conversationId: string | null,
): string | null {
  if (artifact.workspaceId) return `ws:${artifact.workspaceId}`;
  if (conversationId) return `conv:${conversationId}`;
  return null;
}

/** Desks to list for this card. Deletes are skipped (they will not be in the tree). */
export function listingDesksFor(
  artifacts: FileArtifact[],
  conversationId: string | null,
): ListingDesk[] {
  const seen = new Set<string>();
  const out: ListingDesk[] = [];
  for (const a of artifacts) {
    if (a.op === "delete") continue;
    const key = listingDeskKey(a, conversationId);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.workspaceId) out.push({ kind: "ws", id: a.workspaceId });
    else if (conversationId) out.push({ kind: "conv", id: conversationId });
  }
  return out;
}

const inflight = new Map<string, Promise<Map<string, FileListingMeta>>>();

export function loadFileListingMeta(
  desk: ListingDesk,
): Promise<Map<string, FileListingMeta>> {
  const key = `${desk.kind}:${desk.id}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (
    desk.kind === "conv"
      ? listWorkspaceFiles(desk.id)
      : listWorkspaceFilesByWs(desk.id)
  )
    .then((listing) => fileMetaByPath(listing.entries))
    .catch(() => new Map<string, FileListingMeta>())
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test-only: drop in-flight list joins so mocks cannot leak across cases. */
export function resetArtifactListingMetaInflight(): void {
  inflight.clear();
}

export function artifactListingLookupKey(
  artifact: FileArtifact,
  conversationId: string | null,
): string | null {
  const desk = listingDeskKey(artifact, conversationId);
  if (!desk) return null;
  return `${desk}\0${artifact.path}`;
}
