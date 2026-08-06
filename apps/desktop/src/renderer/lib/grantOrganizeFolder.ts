import { hasLocalFiles } from "@/lib/capabilities";
import type { GrantFolderHints } from "@/lib/grantFolderHints";
import { revokeExternalGrant } from "@/lib/revokeExternalGrant";
import { ApiError, api } from "@/services/api";
import type { FsRoot } from "@shared/ipc-contract";

export type { GrantFolderHints } from "@/lib/grantFolderHints";

export type GrantOrganizeResult =
  | {
      ok: true;
      root: FsRoot;
      alias: string;
      namespace: string;
    }
  | { ok: false; reason: "cancelled" | "unavailable" }
  | { ok: false; reason: "error"; message: string };

function describeGrantError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return "对话不存在或无权访问";
  }
  return e instanceof Error ? e.message : "授权失败，请重试";
}

/** Answer text so the CEO sees which folder was granted (no absolute path). */
export function formatGrantOrganizeFolderAnswer(
  optionLabel: string,
  folderName: string,
  namespace: string,
): string {
  return `${optionLabel}（${folderName} → ${namespace}；可移动/重命名/复制/删除进回收站、仅本次对话、可撤销）`;
}

/**
 * OS folder picker (or well-known / target hint) → session organize root →
 * POST grant to server. Orthogonal to workspace binding (cloud scratch + desktop
 * online is enough). Same root upgrading from readonly requires this fresh card
 * (mode updated on re-grant).
 */
export async function pickAndGrantOrganizeFolder(
  conversationId: string,
  hints?: GrantFolderHints,
): Promise<GrantOrganizeResult> {
  if (!hasLocalFiles() || !window.fsApi?.grantSessionReadonlyRoot) {
    return { ok: false, reason: "unavailable" };
  }
  try {
    const root = await window.fsApi.grantSessionReadonlyRoot({
      conversationId,
      mode: "organize",
      ...(hints?.wellKnown ? { wellKnown: hints.wellKnown } : {}),
      ...(hints?.targetName ? { targetName: hints.targetName } : {}),
    });
    if (!root) return { ok: false, reason: "cancelled" };
    try {
      const body = await api.post<{
        grant: { alias: string; namespace: string };
      }>(`/v1/conversations/${conversationId}/workspace/external-grants`, {
        root_id: root.id,
        label: root.name,
        alias_hint: root.alias ?? root.name,
        mode: "organize",
      });
      return {
        ok: true,
        root,
        alias: body.grant.alias,
        namespace: body.grant.namespace,
      };
    } catch (e) {
      await revokeExternalGrant(conversationId, root.id);
      throw e;
    }
  } catch (e) {
    return { ok: false, reason: "error", message: describeGrantError(e) };
  }
}
