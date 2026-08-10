/**
 * 云桌合回 Diff 编排：下载快照 → 解析 → 落点 hash → 应用写入。
 * 不经 applyHandoffJob；写盘仅 workspaceOp。
 */

import { type ReviewRow, buildSelections } from "@/lib/handoff-review";
import {
  MERGE_LANDING_ARCHIVE_MAX_BYTES,
  type MergeLandingApplyRow,
  type MergeLandingApplySummary,
  buildMergeLandingRows,
  bytesByPathFromFiles,
  gateMergeWrite,
  parseCloudZip,
  summarizeApply,
} from "@/lib/mergeLandingDiff";
import { BASE_URL } from "@/services/api";
import { readLocalShas } from "@/services/handoff";
import { createSnapshot } from "@/services/workspace";
import { authedFetch } from "@/services/workspaceHttp";
import type { WorkspaceOpName } from "@shared/ipc-contract";

export type PreparedMergeLandingDiff = {
  conversationId: string;
  rootId: string;
  rootName: string;
  rows: ReviewRow[];
  bytesByPath: Record<string, string>;
  skippedOversized: string[];
  skippedUnreadable: string[];
  truncated: boolean;
};

/**
 * 云 createSnapshot + 下载 zip → 与落点比对 → 评审行。
 */
export async function prepareMergeLandingDiff(
  conversationId: string,
  rootId: string,
  rootName: string,
): Promise<PreparedMergeLandingDiff> {
  const snap = await createSnapshot(conversationId, "合回到本机");
  const res = await authedFetch(
    `${BASE_URL}/v1/conversations/${conversationId}/snapshots/${snap.snapshotId}/download`,
  );
  const blob = await res.blob();
  if (blob.size > MERGE_LANDING_ARCHIVE_MAX_BYTES) {
    throw new Error(
      `云端快照约 ${Math.round(blob.size / (1024 * 1024))}MB，超过合回 Diff 上限（${Math.round(MERGE_LANDING_ARCHIVE_MAX_BYTES / (1024 * 1024))}MB）。请改用「导出 ZIP」或缩小工作区后再试。`,
    );
  }

  const parsed = await parseCloudZip(await blob.arrayBuffer());
  const paths = parsed.files.map((f) => f.path);
  const localShas = await readLocalShas(rootId, paths);

  // 落点过大/不可读 → sha null；若 exists=true 却判成「干净新增」会误覆盖。
  // 用 exists 再核：存在但读不出 sha 的路径诚实跳过。
  const skippedUnreadable: string[] = [];
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (fsApi?.workspaceOp) {
    await Promise.all(
      parsed.files.map(async (f) => {
        if ((localShas.get(f.path) ?? null) !== null) return;
        try {
          const ex = await fsApi.workspaceOp(
            rootId,
            "exists" as WorkspaceOpName,
            { path: f.path },
          );
          if (ex.ok && ex.value === true) {
            skippedUnreadable.push(f.path);
          }
        } catch {
          // ignore
        }
      }),
    );
  }

  const readableFiles = parsed.files.filter(
    (f) => !skippedUnreadable.includes(f.path),
  );
  const rows = buildMergeLandingRows(readableFiles, localShas);

  return {
    conversationId,
    rootId,
    rootName,
    rows,
    bytesByPath: bytesByPathFromFiles(readableFiles),
    skippedOversized: parsed.skippedOversized,
    skippedUnreadable,
    truncated: parsed.truncated,
  };
}

/**
 * 按勾选写入落点；写前再 hash。冲突未 force 不覆盖。
 */
export async function applyMergeLandingDiff(
  rootId: string,
  rows: ReviewRow[],
  bytesByPath: Record<string, string>,
): Promise<MergeLandingApplySummary> {
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.workspaceOp) {
    return summarizeApply([
      {
        path: "",
        status: "error",
        detail: "当前环境无法写入合回落点",
      },
    ]);
  }

  const freshShas = await readLocalShas(
    rootId,
    rows.map((r) => r.change.path),
  );
  const selections = buildSelections(
    rows.map((r) => ({
      ...r,
      localSha: freshShas.get(r.change.path) ?? null,
    })),
  );

  const results: MergeLandingApplyRow[] = [];

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const row = rows[i];
    if (!sel || !row) continue;
    const gate = gateMergeWrite({
      selection: sel,
      resultSha: row.change.resultSha,
      freshLocalSha: freshShas.get(sel.path) ?? null,
    });

    if (gate === "skip_local") {
      results.push({ path: sel.path, status: "skipped", detail: "保留本机" });
      continue;
    }
    if (gate === "skip_applied") {
      results.push({
        path: sel.path,
        status: "skipped",
        detail: "已与云端一致",
      });
      continue;
    }
    if (gate === "conflict") {
      results.push({
        path: sel.path,
        status: "conflict",
        detail: "落点已变或冲突，未覆盖",
      });
      continue;
    }

    const data = bytesByPath[sel.path];
    if (typeof data !== "string") {
      results.push({
        path: sel.path,
        status: "error",
        detail: "缺少云端字节",
      });
      continue;
    }

    try {
      const res = await fsApi.workspaceOp(
        rootId,
        "write_bytes" as WorkspaceOpName,
        { path: sel.path, data },
      );
      if (!res.ok) {
        results.push({
          path: sel.path,
          status: "error",
          detail: res.error?.detail || "写入失败",
        });
      } else {
        results.push({ path: sel.path, status: "applied", detail: "已写入" });
      }
    } catch (e) {
      results.push({
        path: sel.path,
        status: "error",
        detail: e instanceof Error ? e.message : "写入失败",
      });
    }
  }

  return summarizeApply(results);
}
