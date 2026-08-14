import {
  type VersionSource,
  type VersionTimelineEntry,
  snapshotTimelineEntries,
} from "@/components/workspace/changesTimeline";
import { wsListSnapshots } from "@/services/workspaces";
import { useCallback, useEffect, useState } from "react";

/**
 * 文件页「版本」面板的列表来源 —— 只走云端工作区快照 API。
 * 本机命名版本无产品入口；右坞「改动」tab 不再拉版本轨。
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
      setEntries(snapshotTimelineEntries(await wsListSnapshots(source.wsId)));
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
