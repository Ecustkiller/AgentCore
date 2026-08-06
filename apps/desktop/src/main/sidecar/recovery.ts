import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  SidecarPausedTurn,
  SidecarRunsPayload,
} from "@shared/sidecar-contract";
import { sidecarDataDir } from "../outbox-writeback";

/**
 * 直接读本机帧文件，列出某会话待续跑的持久挂起帧（不拉起 sidecar 进程）。
 *
 * 续跑帧由 Python `LocalPausedTurnStore` 落在 `<dataDir>/paused/*.json`，每条记录含顶层
 * `conversation_id` / `created_at` 与已投影好的 `summary`（= 服务端 `PausedTurnSummary` 形状）。
 * 这里读顶层 ``summary``（开工卡）+ 可选 ``display_runs``（协作图），按会话过滤、
 * 按时间排序。summary 与 Python ``listPaused`` RPC 同源；display_runs 仅桌面 hydrate 用。
 * 经 `recovery` IPC 的 `paused[]` / `pausedRuns` 返回（原独立 listPaused 通道已退役）。
 * 尽力而为：任何读/解析失败都降级为「无待续跑」，绝不阻塞重开会话。
 */
export async function readLocalPausedRecovery(conversationId: string): Promise<{
  paused: SidecarPausedTurn[];
  pausedRuns: Record<string, SidecarRunsPayload>;
}> {
  const dir = join(sidecarDataDir(), "paused");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { paused: [], pausedRuns: {} }; // 目录还不存在（从未挂起过）——无待续跑
  }
  const records: {
    createdAt: number;
    summary: SidecarPausedTurn;
    displayRuns?: SidecarRunsPayload | null;
  }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf-8");
      const record = JSON.parse(raw) as {
        conversation_id?: string;
        created_at?: number;
        summary?: SidecarPausedTurn;
        display_runs?: SidecarRunsPayload | null;
      };
      if (record.conversation_id !== conversationId || !record.summary)
        continue;
      records.push({
        createdAt: record.created_at ?? 0,
        summary: record.summary,
        displayRuns: record.display_runs,
      });
    } catch {
      // 撕裂 / 非法帧——跳过这一条，不让它拖垮整次列举
    }
  }
  records.sort((a, b) => a.createdAt - b.createdAt); // oldest-first，与云端一致
  const pausedRuns: Record<string, SidecarRunsPayload> = {};
  for (const r of records) {
    const mid = r.summary.message_id;
    if (
      mid &&
      r.displayRuns &&
      typeof r.displayRuns === "object" &&
      Array.isArray(r.displayRuns.events) &&
      r.displayRuns.events.length > 0
    ) {
      pausedRuns[mid] = r.displayRuns;
    }
  }
  return {
    paused: records.map((r) => r.summary),
    pausedRuns,
  };
}
