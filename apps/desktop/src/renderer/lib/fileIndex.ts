/**
 * @ 提及的条目索引：聚合全部授权根的扁平文件清单 + 派生目录，并提供轻量过滤排序。
 *
 * 索引一次性从主进程拉取（每根有数量上限），在内存中按子串/子序列匹配，
 * 避免每次按键都走 IPC。根目录变动较少，组件生命周期内复用即可。
 *
 * 目录条目由文件路径的各级父目录去重派生（主进程的 listFiles 只返回文件），
 * 选中目录时用 buildDirListing 生成「文件清单」作为上下文（不读取文件正文）。
 */

export type EntryKind = "file" | "dir";

export interface IndexedEntry {
  rootId: string;
  rootName: string;
  /** 相对授权根的路径，分隔符统一为 "/"。 */
  relPath: string;
  name: string;
  /** "rootName/relPath"，用于展示与匹配。 */
  display: string;
  kind: EntryKind;
}

export interface FileIndex {
  /** 文件条目（用于引用单文件，并作为派生目录清单的数据源）。 */
  files: IndexedEntry[];
  /** 目录条目（由文件路径的各级父目录去重派生）。 */
  dirs: IndexedEntry[];
  /** 授权根数量：用于区分「无授权目录」与「有目录但无文件」。 */
  rootCount: number;
}

/** 聚合所有授权根的文件与目录。单根读取失败时跳过该根，不影响其余。 */
export async function loadFileIndex(): Promise<FileIndex> {
  const roots = await window.fsApi.listRoots();
  const files: IndexedEntry[] = [];
  // rootId -> 该根下出现过的目录相对路径集合
  const dirPaths = new Map<string, Set<string>>();
  const rootNames = new Map<string, string>();

  for (const root of roots) {
    rootNames.set(root.id, root.name);
    const res = await window.fsApi.listFiles(root.id);
    if (!res.ok) continue;
    let dirs = dirPaths.get(root.id);
    if (!dirs) {
      dirs = new Set<string>();
      dirPaths.set(root.id, dirs);
    }
    for (const f of res.data) {
      files.push({
        rootId: root.id,
        rootName: root.name,
        relPath: f.relPath,
        name: f.name,
        display: `${root.name}/${f.relPath}`,
        kind: "file",
      });
      // 由文件路径派生各级父目录（去掉文件名后逐级累加）。
      const segs = f.relPath.split("/");
      segs.pop();
      let acc = "";
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg;
        dirs.add(acc);
      }
    }
  }

  const dirs: IndexedEntry[] = [];
  for (const [rootId, set] of dirPaths) {
    const rootName = rootNames.get(rootId) ?? rootId;
    for (const rel of set) {
      const slash = rel.lastIndexOf("/");
      dirs.push({
        rootId,
        rootName,
        relPath: rel,
        name: slash >= 0 ? rel.slice(slash + 1) : rel,
        display: `${rootName}/${rel}`,
        kind: "dir",
      });
    }
  }

  return { files, dirs, rootCount: roots.length };
}

/** 子序列匹配：query 的字符按序出现在 text 中（不要求连续）。 */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j++) {
    if (text[j] === query[i]) i++;
  }
  return i === query.length;
}

function score(entry: IndexedEntry, q: string): number {
  const name = entry.name.toLowerCase();
  const display = entry.display.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  if (name.includes(q)) return 70;
  if (display.includes(q)) return 50;
  if (isSubsequence(q, display)) return 30;
  return 0;
}

/** 按 query 过滤并排序；空 query 返回前 limit 个（按传入顺序）。 */
export function filterEntries(
  index: IndexedEntry[],
  query: string,
  limit = 50,
): IndexedEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return index.slice(0, limit);

  const scored: Array<{ entry: IndexedEntry; s: number }> = [];
  for (const entry of index) {
    const s = score(entry, q);
    if (s > 0) scored.push({ entry, s });
  }
  scored.sort(
    (a, b) => b.s - a.s || a.entry.display.localeCompare(b.entry.display, "zh"),
  );
  return scored.slice(0, limit).map((x) => x.entry);
}

// 小目录平铺完整清单；超过此阈值切换为「目录树骨架 + 计数」概览。
const FLAT_CAP = 200;
const TREE_MAX_LINES = 200; // 骨架最多行数（防超大仓库目录数失控）
const TREE_MAX_DEPTH = 4; // 相对该目录展开的最大深度，更深由计数概括

export interface DirListing {
  /** 供模型阅读的目录上下文文本（小目录=文件清单；大目录=目录树骨架）。 */
  text: string;
  /** 信息被概括/截断（大目录骨架省略了文件名即视为 true）。 */
  truncated: boolean;
  /** 目录内（递归）文件总数。 */
  fileCount: number;
}

interface DirNode {
  name: string;
  /** 递归文件数。 */
  total: number;
  /** 直接位于该目录（非子目录）的文件数。 */
  direct: number;
  children: Map<string, DirNode>;
}

/**
 * 为目录构建上下文文本，分两档：
 * - 文件数 ≤ FLAT_CAP：平铺完整文件清单（相对路径，便于精确引用）。
 * - 文件数 > FLAT_CAP：目录树骨架——只列子目录并标注各自递归文件数，省略
 *   具体文件名，避免把超大目录的上千条路径塞进上下文。
 *
 * 全程不读取任何文件正文。数据源是已索引的 files（主进程 listFiles 的递归
 * 结果，本身已忽略 node_modules/.git 等并有总数上限），按 rootId + 前缀筛选。
 */
export function buildDirListing(
  files: IndexedEntry[],
  dir: IndexedEntry,
): DirListing {
  const prefix = `${dir.relPath}/`;
  const rels: string[] = [];
  for (const f of files) {
    if (f.rootId !== dir.rootId) continue;
    if (f.relPath.startsWith(prefix)) rels.push(f.relPath.slice(prefix.length));
  }
  rels.sort((a, b) => a.localeCompare(b, "zh"));
  const fileCount = rels.length;

  // 小目录：平铺完整清单。
  if (fileCount <= FLAT_CAP) {
    const header = `${dir.display}/ (${fileCount} 个文件)`;
    const body = rels.map((r) => `  ${r}`).join("\n");
    return {
      text: body ? `${header}\n${body}` : header,
      truncated: false,
      fileCount,
    };
  }

  // 大目录：聚合为目录树（子目录 + 递归/直接文件计数）。
  const root: DirNode = {
    name: dir.name,
    total: 0,
    direct: 0,
    children: new Map(),
  };
  for (const rel of rels) {
    const segs = rel.split("/");
    segs.pop(); // 去掉文件名，只留目录段
    root.total++;
    let node = root;
    for (const seg of segs) {
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, total: 0, direct: 0, children: new Map() };
        node.children.set(seg, child);
      }
      child.total++;
      node = child;
    }
    node.direct++;
  }

  const lines: string[] = [];
  let over = false;
  const walk = (node: DirNode, depth: number, indent: string): void => {
    const kids = [...node.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "zh"),
    );
    for (const k of kids) {
      if (lines.length >= TREE_MAX_LINES) {
        over = true;
        return;
      }
      lines.push(`${indent}${k.name}/ (${k.total})`);
      if (depth + 1 < TREE_MAX_DEPTH && k.children.size > 0) {
        walk(k, depth + 1, `${indent}  `);
      }
    }
  };
  walk(root, 0, "  ");
  if (root.direct > 0) {
    lines.push(`  （另有 ${root.direct} 个文件直接位于该目录）`);
  }
  if (over) lines.push("  …（更多子目录已省略）");

  const header = `${dir.display}/ (${fileCount} 个文件，目录结构概览；已省略文件名，括号内为各目录递归文件数)`;
  return { text: `${header}\n${lines.join("\n")}`, truncated: true, fileCount };
}
