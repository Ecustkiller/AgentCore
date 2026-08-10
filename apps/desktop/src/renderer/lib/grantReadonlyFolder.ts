import { hasLocalFiles } from "@/lib/capabilities";
import type { GrantFolderHints } from "@/lib/grantFolderHints";
import { revokeExternalGrant } from "@/lib/revokeExternalGrant";
import { ApiError, api } from "@/services/api";
import { invalidateExternalGrants } from "@/services/externalGrants";
import type {
  FsRoot,
  GrantSessionReadonlyRootFailReason,
} from "@shared/ipc-contract";

export type { GrantFolderHints } from "@/lib/grantFolderHints";
export { grantHintsFromAskOption } from "@/lib/grantFolderHints";

export type GrantReadonlyFailReason =
  | "unavailable"
  | GrantSessionReadonlyRootFailReason
  | "error";

export type GrantReadonlyResult =
  | {
      ok: true;
      root: FsRoot;
      alias: string;
      namespace: string;
      displayLabel?: string;
    }
  | { ok: false; reason: "unavailable" }
  | {
      ok: false;
      reason: Exclude<GrantReadonlyFailReason, "unavailable">;
      message: string;
    };

const RESOLVE_FAIL_FALLBACK: Record<
  Exclude<GrantSessionReadonlyRootFailReason, "invalid">,
  string
> = {
  not_found: "找不到该目录",
  permission_denied: "定位到了，但这台电脑不让程序读取该目录",
  not_directory: "路径指向的是文件，不是目录",
  ambiguous: "匹配到多个目录，请说得更具体",
};

function describeGrantError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return "对话不存在或无权访问";
  }
  return e instanceof Error ? e.message : "授权失败，请重试";
}

/** Answer text so the CEO sees which folder was granted (no absolute path). */
export function formatGrantReadonlyFolderAnswer(
  optionLabel: string,
  folderName: string,
  namespace: string,
): string {
  return `${optionLabel}（${folderName} → ${namespace}；只读、仅本次对话、可撤销）`;
}

/**
 * Resolve grant hints (path / wellKnown / targetName) → session read-only root →
 * POST grant to server. Never opens a folder picker; unresolved → not_found
 * (≠ cancelled). Orthogonal to workspace binding.
 */
export async function pickAndGrantReadonlyFolder(
  conversationId: string,
  hints?: GrantFolderHints,
): Promise<GrantReadonlyResult> {
  if (!hasLocalFiles() || !window.fsApi?.grantSessionReadonlyRoot) {
    return { ok: false, reason: "unavailable" };
  }
  try {
    const granted = await window.fsApi.grantSessionReadonlyRoot({
      conversationId,
      mode: "readonly",
      ...(hints?.path ? { path: hints.path } : {}),
      ...(hints?.wellKnown ? { wellKnown: hints.wellKnown } : {}),
      ...(hints?.targetName ? { targetName: hints.targetName } : {}),
    });
    if (!granted.ok) {
      const reason = granted.reason;
      if (reason === "invalid") {
        return {
          ok: false,
          reason: "error",
          message: granted.message ?? "无效的请求参数",
        };
      }
      return {
        ok: false,
        reason,
        message: granted.message ?? RESOLVE_FAIL_FALLBACK[reason],
      };
    }
    const root = granted.root;
    try {
      const body = await api.post<{
        grant: { alias: string; namespace: string };
      }>(`/v1/conversations/${conversationId}/workspace/external-grants`, {
        root_id: root.id,
        label: root.name,
        alias_hint: root.alias ?? root.name,
      });
      invalidateExternalGrants(conversationId);
      return {
        ok: true,
        root,
        alias: body.grant.alias,
        namespace: body.grant.namespace,
        displayLabel: granted.displayLabel,
      };
    } catch (e) {
      await revokeExternalGrant(conversationId, root.id);
      throw e;
    }
  } catch (e) {
    return { ok: false, reason: "error", message: describeGrantError(e) };
  }
}
