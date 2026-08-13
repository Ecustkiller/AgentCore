import { type FileNode, type FileSource, parentDir } from "@/lib/fileSource";
import { isAgentCoreRootDir } from "@/lib/stageDirs";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { FileSortBy } from "./fileTreeTypes";

export type DirStatus = "loading" | "ready" | "error";

/**
 * 兄弟排序档位：目录 → 文件 → 「AI 工作间」（盘上 ``AgentCore/``）。工作间装的是 AI
 * 的过程材料，用户平时不必打开，故沉到同级最后，不抢用户自己文件的位置。
 */
function siblingRank(node: FileNode): number {
  if (isAgentCoreRootDir(node.path)) return 2;
  return node.isDir ? 0 : 1;
}

/** 降序比较一项可缺失的数值元信息（大 / 新在前；缺失沉底）。 */
function compareDescNullable(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const av = a ?? null;
  const bv = b ?? null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return bv - av;
}

/**
 * Dirs first, then by the chosen key — the canonical tree ordering (mutates +
 * returns). Name is always the tie-break, so equal sizes / timestamps still land
 * in a stable, readable order.
 */
export function sortNodes(
  nodes: FileNode[],
  by: FileSortBy = "name",
): FileNode[] {
  return nodes.sort((a, b) => {
    const rankA = siblingRank(a);
    const rankB = siblingRank(b);
    if (rankA !== rankB) return rankA - rankB;
    const keyed =
      by === "size"
        ? compareDescNullable(a.sizeBytes, b.sizeBytes)
        : by === "mtime"
          ? compareDescNullable(a.mtimeMs, b.mtimeMs)
          : 0;
    return keyed !== 0 ? keyed : a.name.localeCompare(b.name);
  });
}

/**
 * Fold a flat recursive listing into a per-parent children map (dir → its direct
 * children). The root bucket ("") is always present; every listed directory gets
 * an entry too (empty if it has no listed children) so the tree can render it as
 * a known-empty folder rather than a perpetual spinner.
 */
export function bucketTree(
  nodes: FileNode[],
  by: FileSortBy = "name",
): Map<string, FileNode[]> {
  const map = new Map<string, FileNode[]>([["", []]]);
  const bucket = (dir: string): FileNode[] => {
    let arr = map.get(dir);
    if (!arr) {
      arr = [];
      map.set(dir, arr);
    }
    return arr;
  };
  for (const n of nodes) {
    bucket(parentDir(n.path)).push(n);
    if (n.isDir) bucket(n.path);
  }
  for (const arr of map.values()) sortNodes(arr, by);
  return map;
}

export interface FileTreeData {
  /** Direct children of a directory, or undefined if not loaded yet. */
  childrenOf: (dir: string) => FileNode[] | undefined;
  statusOf: (dir: string) => DirStatus | undefined;
  /**
   * 这一层是否被后端条目上限截断（源不报告即为 false）。UI 必须把它显示出来——
   * 悄悄少几十个文件，用户读到的是「我的文件没了」。
   */
  truncatedOf: (dir: string) => boolean;
  /** Load a directory's children if not already loaded/loading (lazy sources). */
  ensureDir: (dir: string) => void;
  /** Reload one directory — eager sources reload the whole tree. */
  reload: (dir: string) => void;
}

/**
 * The data layer behind {@link FileTree}, abstracting a source's two listing
 * styles behind one uniform read API (文件中枢统一 Step 0):
 *
 * - **eager** (`source.listTree` present, e.g. the server workspace): one
 *   recursive fetch buckets the whole tree into memory; every dir is `ready`,
 *   and reload re-fetches the lot. Natural for a small, server-enumerable space.
 * - **lazy** (`listDir` only, e.g. a local OS root): each directory loads on
 *   first expand; reload re-fetches just that level. Necessary for large trees.
 *
 * Either way the consumer just calls `childrenOf` / `ensureDir`; the rendering is
 * identical. Data lives in refs (mutated in place) with a version bump to
 * re-render, avoiding a fresh Map allocation per directory load.
 */
export function useFileTreeData(
  source: FileSource,
  sortBy: FileSortBy = "name",
): FileTreeData {
  const eager = !!source.listTree;
  const childrenRef = useRef<Map<string, FileNode[]>>(new Map());
  const statusRef = useRef<Map<string, DirStatus>>(new Map());
  const truncatedRef = useRef<Set<string>>(new Set());
  // Read by the loaders so changing the sort never invalidates them (that would
  // re-run the mount effect and refetch the whole tree just to reorder it).
  const sortRef = useRef(sortBy);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const loadEager = useCallback(async () => {
    const listTree = source.listTree;
    if (!listTree) return;
    statusRef.current.set("", "loading");
    bump();
    try {
      const all = await listTree();
      childrenRef.current = bucketTree(all, sortRef.current);
      const status = new Map<string, DirStatus>();
      for (const dir of childrenRef.current.keys()) status.set(dir, "ready");
      statusRef.current = status;
    } catch {
      statusRef.current = new Map([["", "error"]]);
    }
    bump();
  }, [source]);

  const loadDir = useCallback(
    async (dir: string) => {
      statusRef.current.set(dir, "loading");
      bump();
      try {
        // Prefer the bounded reader so a capped level can say so; sources that
        // enumerate in full only implement `listDir` and stay un-truncated.
        const bounded = source.listDirBounded;
        const res = bounded
          ? await bounded(dir)
          : { entries: await source.listDir(dir), truncated: false };
        childrenRef.current.set(dir, sortNodes(res.entries, sortRef.current));
        if (res.truncated) truncatedRef.current.add(dir);
        else truncatedRef.current.delete(dir);
        statusRef.current.set(dir, "ready");
      } catch {
        statusRef.current.set(dir, "error");
      }
      bump();
    },
    [source],
  );

  // Reset + initial load whenever the source identity changes.
  useEffect(() => {
    childrenRef.current = new Map();
    statusRef.current = new Map();
    truncatedRef.current = new Set();
    bump();
    if (eager) void loadEager();
    else void loadDir("");
  }, [eager, loadEager, loadDir]);

  // Switching the sort key reorders what's already in memory — never a refetch.
  useEffect(() => {
    sortRef.current = sortBy;
    for (const arr of childrenRef.current.values()) sortNodes(arr, sortBy);
    bump();
  }, [sortBy]);

  const ensureDir = useCallback(
    (dir: string) => {
      if (eager) return; // whole tree already in memory
      if (statusRef.current.has(dir)) return; // loading / ready / error already
      void loadDir(dir);
    },
    [eager, loadDir],
  );

  const reload = useCallback(
    (dir: string) => {
      if (eager) void loadEager();
      else void loadDir(dir);
    },
    [eager, loadEager, loadDir],
  );

  // Stable readers (read live refs) + a memoized facade so effects/handlers can
  // depend on `data` without re-firing every render; identity changes only with
  // the source. Re-renders are driven by `bump`, so render-time reads stay fresh.
  const childrenOf = useCallback(
    (dir: string) => childrenRef.current.get(dir),
    [],
  );
  const statusOf = useCallback((dir: string) => statusRef.current.get(dir), []);
  const truncatedOf = useCallback(
    (dir: string) => truncatedRef.current.has(dir),
    [],
  );

  return useMemo(
    () => ({ childrenOf, statusOf, truncatedOf, ensureDir, reload }),
    [childrenOf, statusOf, truncatedOf, ensureDir, reload],
  );
}
