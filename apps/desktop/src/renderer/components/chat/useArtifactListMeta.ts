import type { FileArtifact } from "@/lib/fileArtifacts";
import { type FileNode, type FileSource, parentDir } from "@/lib/fileSource";
import { useCallback, useEffect, useMemo, useState } from "react";

/** 工作区 list 命中后的软元信息；缺哪项就空着，不编造。 */
export type ArtifactListMeta = {
  sizeBytes: number | null;
  mtimeMs: number | null;
};

/**
 * 产物行是否该问「当前会话工作区」的 list。
 *
 * 带了别的 `workspaceId` 却拿会话桌的条目去填，会把另一张桌的数字当成这份文件——
 * 对不上就空着，比张冠李戴诚实。
 */
export function artifactOnSessionDesk(
  artifact: FileArtifact,
  sessionWsId: string | null | undefined,
): boolean {
  return !artifact.workspaceId || artifact.workspaceId === sessionWsId;
}

/** 把一层 list 结果收成 path → 大小/时间（跳过目录；字段缺省按 null）。 */
export function indexListedFileMeta(
  entries: readonly FileNode[],
): Map<string, ArtifactListMeta> {
  const map = new Map<string, ArtifactListMeta>();
  for (const e of entries) {
    if (e.isDir) continue;
    map.set(e.path, {
      sizeBytes: e.sizeBytes ?? null,
      mtimeMs: e.mtimeMs ?? null,
    });
  }
  return map;
}

/**
 * 按路径向已有工作区 list 取大小 / 修改时间（方案甲：卡片问文件树，不改 SSE）。
 *
 * 每个产物父目录一次 `listDir`（与文件树懒列举同一接口，不新造 list）。
 * 对不上、list 失败、源还没到、或字段为空 → 该行不占位。
 */
export function useArtifactListMeta(
  source: FileSource | null,
  artifacts: readonly FileArtifact[],
  sessionWsId?: string | null,
): (artifact: FileArtifact) => ArtifactListMeta | undefined {
  const [index, setIndex] = useState<Map<string, ArtifactListMeta>>(
    () => new Map(),
  );

  const parents = useMemo(() => {
    const dirs = new Set<string>();
    for (const a of artifacts) {
      if (a.op === "delete") continue;
      if (!artifactOnSessionDesk(a, sessionWsId)) continue;
      dirs.add(parentDir(a.path));
    }
    return [...dirs].sort();
  }, [artifacts, sessionWsId]);

  useEffect(() => {
    if (
      !source ||
      typeof source.listDir !== "function" ||
      parents.length === 0
    ) {
      setIndex((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    void Promise.all(
      parents.map((dir) => source.listDir(dir).catch(() => [] as FileNode[])),
    ).then((layers) => {
      if (cancelled) return;
      const next = new Map<string, ArtifactListMeta>();
      for (const entries of layers) {
        for (const [path, meta] of indexListedFileMeta(entries)) {
          next.set(path, meta);
        }
      }
      setIndex(next);
    });
    return () => {
      cancelled = true;
    };
  }, [source, parents]);

  return useCallback(
    (artifact: FileArtifact) => {
      if (!artifactOnSessionDesk(artifact, sessionWsId)) return undefined;
      return index.get(artifact.path);
    },
    [index, sessionWsId],
  );
}
