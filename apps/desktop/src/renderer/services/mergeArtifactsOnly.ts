/**
 * §7.6 ① 仅产物快捷合回：从 delivery 投影取路径 → 云桌读字节 → 写合回落点。
 * 不碰 Diff 主管线；落点已有同路径默认跳过并提示（禁静默覆盖）。
 */

import { bytesToBase64 } from "@/lib/mergeLandingDiff";
import { BASE_URL } from "@/services/api";
import { fetchWorkspaceFileBlob } from "@/services/workspace";
import { authedFetch, encodePath } from "@/services/workspaceHttp";
import type { DeliveryStatusPayload } from "@/types/events";
import type { WorkspaceOpName } from "@shared/ipc-contract";
import { toWorkspaceRelPath } from "@shared/workspace-path";

export type MergeArtifactRef = {
  path: string;
  /** 有则按 workspace REST 读；否则会话云桌。 */
  workspaceId?: string;
};

export type WriteArtifactsSummary = {
  written: string[];
  skippedExisting: string[];
  errors: { path: string; detail: string }[];
};

function dedupeRefs(refs: MergeArtifactRef[]): MergeArtifactRef[] {
  const byPath = new Map<string, MergeArtifactRef>();
  const order: string[] = [];
  for (const r of refs) {
    if (!byPath.has(r.path)) order.push(r.path);
    byPath.set(r.path, r);
  }
  const out: MergeArtifactRef[] = [];
  for (const p of order) {
    const ref = byPath.get(p);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * 产物路径：优先 `artifacts` 中 accepted；若无则用 `delivered_files`。
 * 两者皆空 → []（调用方提示「本回合无交付产物」）。
 */
export function resolveMergeArtifactRefs(
  status: DeliveryStatusPayload | null | undefined,
): MergeArtifactRef[] {
  if (!status) return [];

  if (Array.isArray(status.artifacts)) {
    const accepted: MergeArtifactRef[] = [];
    for (const row of status.artifacts) {
      if (row.status !== "accepted") continue;
      const path = toWorkspaceRelPath(
        typeof row.path === "string" ? row.path : "",
      );
      if (!path) continue;
      const workspaceId =
        typeof row.workspace_id === "string" && row.workspace_id.trim()
          ? row.workspace_id.trim()
          : undefined;
      accepted.push(workspaceId ? { path, workspaceId } : { path });
    }
    if (accepted.length > 0) return dedupeRefs(accepted);
  }

  const fromDelivered: MergeArtifactRef[] = [];
  for (const raw of status.delivered_files ?? []) {
    const path = toWorkspaceRelPath(typeof raw === "string" ? raw : "");
    if (path) fromDelivered.push({ path });
  }
  return dedupeRefs(fromDelivered);
}

async function readCloudArtifactBytes(
  conversationId: string,
  ref: MergeArtifactRef,
): Promise<Uint8Array> {
  if (ref.workspaceId) {
    const res = await authedFetch(
      `${BASE_URL}/v1/workspaces/${encodeURIComponent(ref.workspaceId)}/files/${encodePath(ref.path)}`,
    );
    return new Uint8Array(await res.arrayBuffer());
  }
  const blob = await fetchWorkspaceFileBlob(conversationId, ref.path);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 逐文件写落点：已存在 → 跳过；否则 write_bytes。
 */
export async function writeArtifactsToLanding(opts: {
  conversationId: string;
  rootId: string;
  refs: MergeArtifactRef[];
}): Promise<WriteArtifactsSummary> {
  const written: string[] = [];
  const skippedExisting: string[] = [];
  const errors: { path: string; detail: string }[] = [];

  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.workspaceOp) {
    return {
      written,
      skippedExisting,
      errors: [{ path: "", detail: "当前环境无法写入合回落点" }],
    };
  }

  for (const ref of opts.refs) {
    try {
      const exists = await fsApi.workspaceOp(
        opts.rootId,
        "exists" as WorkspaceOpName,
        { path: ref.path },
      );
      if (exists.ok && exists.value === true) {
        skippedExisting.push(ref.path);
        continue;
      }

      const bytes = await readCloudArtifactBytes(opts.conversationId, ref);
      const res = await fsApi.workspaceOp(
        opts.rootId,
        "write_bytes" as WorkspaceOpName,
        { path: ref.path, data: bytesToBase64(bytes) },
      );
      if (!res.ok) {
        errors.push({
          path: ref.path,
          detail: res.error?.detail || "写入失败",
        });
      } else {
        written.push(ref.path);
      }
    } catch (e) {
      errors.push({
        path: ref.path,
        detail: e instanceof Error ? e.message : "写入失败",
      });
    }
  }

  return { written, skippedExisting, errors };
}
