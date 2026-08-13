/**
 * 「改动」tab 的统一时间轴模型 —— 改动与版本本就是一个功能，合成一条倒序流：
 * 回合条目（逐文件 diff + 恢复到本回合开始）、用户留存版本、交接存档。
 *
 * 云端快照与本机命名版本在这里归一成同一种 {@link VersionTimelineEntry}：两种存储只在
 * **能做什么**上分叉（云端能下载、本机能删除），时间轴上是同一条轨、同一张卡——用户要问的
 * 是「什么时候变成什么样、怎么回去」，不是「这份 zip 躺在谁的盘上」。
 *
 * 不单列自动备份（label 为空）与 `turn-baseline:`：回合 N 的结束态与回合 N+1 的
 * 基线是同一个时间点，回合条目已经代表它，再排一行只是系统复读。可见性过滤复用
 * {@link visibleSnapshots}（它另外挡掉导出 / 预览这类传输副产物）。
 */

import {
  classifySnapshotLabel,
  snapshotDisplayHint,
  snapshotDisplayTitle,
  visibleSnapshots,
} from "@/components/workspace/snapshotDisplay";
import type { FileArtifact } from "@/lib/fileArtifacts";
import type {
  LocalWorkspaceTarget,
  WorkspaceVersion,
} from "@/services/localWorkspaceVersions";
import type { WorkspaceSnapshot } from "@/services/workspace";

/** 一个 AI 回合的文件改动。 */
export interface TurnTimelineEntry {
  kind: "turn";
  id: string;
  /** assistant projection id —— 真 diff / 基线回滚的 turnKey。 */
  messageId: string;
  label: string;
  artifacts: FileArtifact[];
  at: string;
}

/**
 * 版本住在哪里 —— 决定条目能做什么，不决定它长什么样。
 * 一个工作区只会是其中一种，所以整条轨共用一个 source。
 *
 * 两个云端变体只差**寻址**（对话别名 vs 工作区 id），后端落到同一个存储键：右坞手里有
 * 会话、文件页手里只有工作区。不合成一个是因为两条路由的「本机拒绝」门不完全同形
 * （会话侧还看容器根绑定），把它们当同一件东西会把这道差异抹掉。
 */
export type VersionSource =
  | { origin: "cloud"; conversationId: string }
  | { origin: "cloudWs"; wsId: string }
  | { origin: "local"; target: LocalWorkspaceTarget };

/** 用户主动打的锚点（version）或系统交接存档（archive），云端本机同一形状。 */
export interface VersionTimelineEntry {
  kind: "version" | "archive";
  /** 云端 snapshotId / 本机 versionId —— 下载、恢复、删除都用它寻址。 */
  id: string;
  /** 卡片标题（系统 label 已归一为人话）。 */
  title: string;
  /** 标题被改写时的原始 label，只进 tooltip；本机命名版本恒为 null。 */
  rawLabel: string | null;
  sizeBytes: number;
  at: string;
}

export type ChangesTimelineEntry = TurnTimelineEntry | VersionTimelineEntry;

function timeValue(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 云端快照列表 → 时间轴条目：只留用户版本与交接存档。 */
export function snapshotTimelineEntries(
  snaps: readonly WorkspaceSnapshot[],
): VersionTimelineEntry[] {
  const out: VersionTimelineEntry[] = [];
  for (const snapshot of visibleSnapshots(snaps)) {
    const kind = classifySnapshotLabel(snapshot.label);
    if (kind === "auto") continue;
    out.push({
      kind: kind === "kept" ? "version" : "archive",
      id: snapshot.snapshotId,
      title: snapshotDisplayTitle(snapshot.label),
      rawLabel: snapshotDisplayHint(snapshot.label),
      sizeBytes: snapshot.sizeBytes,
      at: snapshot.createdAt,
    });
  }
  return out;
}

/**
 * 本机命名版本 → 时间轴条目。本机版本区只收用户显式留的版本（自动备份与回合基线
 * 各有各的目录），所以不需要分类，全部是 version。
 */
export function localVersionTimelineEntries(
  versions: readonly WorkspaceVersion[],
): VersionTimelineEntry[] {
  return versions.map((v) => ({
    kind: "version",
    id: v.versionId,
    title: v.name,
    rawLabel: null,
    sizeBytes: v.sizeBytes,
    at: v.createdAt,
  }));
}

/**
 * 倒序穿插两类条目。`turns` 按回合升序传入（回合 1 在前）。
 * 同一时刻版本压回合：版本是回合跑起来之后才打的锚点。
 */
export function mergeChangesTimeline(
  turns: readonly TurnTimelineEntry[],
  versions: readonly VersionTimelineEntry[],
): ChangesTimelineEntry[] {
  const merged: ChangesTimelineEntry[] = [...versions, ...[...turns].reverse()];
  return merged.sort((a, b) => timeValue(b.at) - timeValue(a.at));
}
