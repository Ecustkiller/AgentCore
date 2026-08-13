import type { FileNode } from "@/lib/fileSource";

/**
 * 文件树多选（选区代数）。
 *
 * 交互沿用桌面文件管理器的通行约定，不发明新语汇：普通点击 = 单选（并照旧打开 / 展开），
 * Ctrl/Cmd 点击 = 在选区里加减一行，Shift 点击 = 从锚点连选，Esc = 清空。这里只放**纯函数**，
 * 状态与副作用（确认、批量调用、刷新）留在 {@link useFileTreeBatch}，故这套规则可以单测。
 */

/** 选区里的一项。`isDir` 决定批量动作怎么分流（目录不可逐项下载、删除要递归提示）。 */
export interface SelectedItem {
  path: string;
  isDir: boolean;
}

/**
 * 选区状态。
 *
 * `items` 按**可见行顺序**排列（不是点选先后）——确认框清单、失败清单都照这个顺序读，与用户
 * 在树里看到的次序一致。`anchor` 是最近一次「非 Shift」点选的行；Shift 连选以它为起点。
 */
export interface TreeSelection {
  items: readonly SelectedItem[];
  anchor: string | null;
}

export const EMPTY_SELECTION: TreeSelection = { items: [], anchor: null };

/** 一次行点击的修饰键意图；两者皆假 = 普通点击。 */
export interface RowClickIntent {
  /** Ctrl / Cmd：在选区里加减这一行。 */
  toggle: boolean;
  /** Shift：从锚点连选到这一行。 */
  range: boolean;
}

export function clickIntent(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): RowClickIntent {
  return { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey };
}

/**
 * 这次点击是否「只改选区」——带修饰键时不打开文件、不展开目录，否则加选一个文件就会顺手
 * 把预览换掉（详情区仍只跟普通点击走）。
 */
export function isSelectionOnlyClick(intent: RowClickIntent): boolean {
  return intent.toggle || intent.range;
}

export function selectionHas(sel: TreeSelection, path: string): boolean {
  return sel.items.some((i) => i.path === path);
}

export function selectionPaths(sel: TreeSelection): Set<string> {
  return new Set(sel.items.map((i) => i.path));
}

function itemOf(node: FileNode | SelectedItem): SelectedItem {
  return { path: node.path, isDir: node.isDir };
}

/** 按可见行顺序重排；已不在可见行里的项（父目录被折叠 / 被筛掉）保持原相对次序缀在后面。 */
function orderByVisible(
  items: readonly SelectedItem[],
  visible: readonly SelectedItem[],
): SelectedItem[] {
  const rest = new Map(items.map((i) => [i.path, i]));
  const out: SelectedItem[] = [];
  for (const row of visible) {
    const hit = rest.get(row.path);
    if (hit) {
      out.push(hit);
      rest.delete(row.path);
    }
  }
  return [...out, ...rest.values()];
}

/**
 * 一次行点击后的新选区。
 *
 * Shift 连选取锚点到本行的闭区间（**替换**选区，与 Explorer / Finder 一致）；锚点已不在可见行
 * 里（折叠或筛掉）时退化成单选，免得连出一段用户根本看不见的选区。
 */
export function selectRow(
  sel: TreeSelection,
  node: FileNode | SelectedItem,
  intent: RowClickIntent,
  visible: readonly SelectedItem[],
): TreeSelection {
  if (intent.range && sel.anchor) {
    const from = visible.findIndex((r) => r.path === sel.anchor);
    const to = visible.findIndex((r) => r.path === node.path);
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return {
        items: visible.slice(lo, hi + 1).map(itemOf),
        anchor: sel.anchor,
      };
    }
  }
  if (intent.toggle) {
    const next = selectionHas(sel, node.path)
      ? sel.items.filter((i) => i.path !== node.path)
      : [...sel.items, itemOf(node)];
    return { items: orderByVisible(next, visible), anchor: node.path };
  }
  return { items: [itemOf(node)], anchor: node.path };
}

/**
 * 右键落点对选区的影响：点在选区**内**保持整个选区（菜单对这一批生效），点在选区**外**收敛
 * 成单选（否则用户会对着一行按删除、却删掉别处几项）。
 */
export function selectionForContextMenu(
  sel: TreeSelection,
  node: FileNode | SelectedItem,
): TreeSelection {
  if (selectionHas(sel, node.path)) return sel;
  return { items: [itemOf(node)], anchor: node.path };
}

/**
 * 剔除「祖先也在选区里」的后代。
 *
 * 选了 `a/` 又选了 `a/b.md` 时，删掉 `a/` 后 `a/b.md` 已经不存在，再删一次只会收到一条
 * 「文件不存在」——那是我们自己造的假失败。移动同理（父目录一走，子项路径就变了）。
 */
export function topLevelSelection(
  items: readonly SelectedItem[],
): SelectedItem[] {
  const dirPrefixes = items.filter((i) => i.isDir).map((i) => `${i.path}/`);
  return items.filter((i) => !dirPrefixes.some((p) => i.path.startsWith(p)));
}

/**
 * 当前**可见行**（渲染顺序）——Shift 连选与「全选」都以它为准，故必须与 {@link FileTreeRow}
 * 的渲染次序逐行一致：根层子项按序，目录展开时紧跟其子层，筛选态只留命中项。
 */
export function flattenVisibleRows(opts: {
  childrenOf: (dir: string) => FileNode[] | undefined;
  expanded: ReadonlySet<string>;
  filterVisible?: ReadonlySet<string> | null;
  hideRootDirs?: readonly string[];
}): SelectedItem[] {
  const { childrenOf, expanded, filterVisible, hideRootDirs } = opts;
  const out: SelectedItem[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 64) return; // 防御异常数据造出的环
    const loaded = childrenOf(dir);
    if (!loaded) return;
    const level =
      dir === "" && hideRootDirs?.length
        ? loaded.filter((n) => !(n.isDir && hideRootDirs.includes(n.name)))
        : loaded;
    for (const node of level) {
      if (filterVisible && !filterVisible.has(node.path)) continue;
      out.push(itemOf(node));
      if (node.isDir && expanded.has(node.path)) walk(node.path, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
