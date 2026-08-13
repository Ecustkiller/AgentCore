import {
  type VersionSource,
  type VersionTimelineEntry,
  localVersionTimelineEntries,
  snapshotTimelineEntries,
} from "@/components/workspace/changesTimeline";
import { listLocalVersions } from "@/services/localWorkspaceVersions";
import { listSnapshots } from "@/services/workspace";
import { wsListSnapshots } from "@/services/workspaces";
import { useCallback, useEffect, useState } from "react";

/**
 * 「改动」tab 时间轴的版本来源 —— 云端快照 API 或本机版本区，两边归一成同一批条目。
 *
 * 版本轨拉不到不能吃掉回合改动 —— 失败只翻 `failed` 位、由面板给一行诚实提示 + 重试，
 * 回合条目照常渲染。`source` 为 null（工作区没有可寻址的版本区）时是空列表，不是失败。
 *
 * 调用方须 memo 化 `source`：它就是重拉的依赖。
 */
export function useChangesVersions(source: VersionSource | null): {
  entries: VersionTimelineEntry[];
  failed: boolean;
  reload: () => Promise<void>;
} {
  const [entries, setEntries] = useState<VersionTimelineEntry[]>([]);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    if (!source) {
      setEntries([]);
      setFailed(false);
      return;
    }
    try {
      if (source.origin === "local") {
        setEntries(
          localVersionTimelineEntries(await listLocalVersions(source.target)),
        );
      } else if (source.origin === "cloudWs") {
        setEntries(snapshotTimelineEntries(await wsListSnapshots(source.wsId)));
      } else {
        setEntries(
          snapshotTimelineEntries(await listSnapshots(source.conversationId)),
        );
      }
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { entries, failed, reload };
}
