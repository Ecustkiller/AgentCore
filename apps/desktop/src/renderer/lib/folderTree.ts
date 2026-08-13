import type { FolderMeta } from "@/services/folders";

/**
 * 我的文件 = the user's cloud folders as a real directory tree (双模式工作区 §5.4).
 *
 * Nesting is expressed by `relPath` alone — `设计/图标` sits inside `设计`. There
 * is no `parent_id` column to disagree with the path, so the client rebuilds the
 * tree the same way the server derives it: index the live folders by `relPath`,
 * then hang each one off whatever `parentRelPath` points at.
 */
export interface FolderTreeNode {
  folder: FolderMeta;
  /** 0 for a top-level folder; +1 per nesting level. */
  depth: number;
  children: FolderTreeNode[];
}

/** POSIX rel path with the empty / null root collapsed to `""`. */
function normalizeRel(rel: string | null | undefined): string {
  return (rel ?? "").replace(/^\/+|\/+$/g, "");
}

function byName(a: FolderTreeNode, b: FolderTreeNode): number {
  return a.folder.name.localeCompare(b.folder.name, "zh");
}

/**
 * Nest `folders` by `relPath`, siblings sorted by name.
 *
 * A folder whose parent is not in `folders` (its parent is local-bound, or the
 * list is mid-refresh) surfaces at the top level rather than disappearing — the
 * rail must never swallow a folder just because its ancestor was filtered out.
 * Folders with no `relPath` (legacy rows the tree backfill has not reached) are
 * top-level too.
 */
export function buildFolderTree(folders: FolderMeta[]): FolderTreeNode[] {
  const nodes = folders.map<FolderTreeNode>((folder) => ({
    folder,
    depth: 0,
    children: [],
  }));
  const byRelPath = new Map<string, FolderTreeNode>();
  for (const node of nodes) {
    const rel = normalizeRel(node.folder.relPath);
    if (rel) byRelPath.set(rel, node);
  }

  const roots: FolderTreeNode[] = [];
  for (const node of nodes) {
    const rel = normalizeRel(node.folder.relPath);
    const parentRel = normalizeRel(node.folder.parentRelPath);
    const parent = rel && parentRel ? byRelPath.get(parentRel) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const applyDepth = (list: FolderTreeNode[], depth: number) => {
    list.sort(byName);
    for (const node of list) {
      node.depth = depth;
      applyDepth(node.children, depth + 1);
    }
  };
  applyDepth(roots, 0);
  return roots;
}

/**
 * Names of a folder's direct child folders.
 *
 * Their directories physically live inside the parent's, so the parent's file
 * tree would list them a second time — as plain directories, stripped of the
 * folder identity (记忆 / 规则 / 删除) the rail row carries. The rail hides them
 * from the tree instead, so every folder appears exactly once.
 */
export function childFolderNames(node: FolderTreeNode): string[] {
  const names: string[] = [];
  for (const child of node.children) {
    const rel = normalizeRel(child.folder.relPath);
    const segment = rel.slice(rel.lastIndexOf("/") + 1);
    if (segment) names.push(segment);
  }
  return names;
}

/**
 * Keep the nodes `keep` accepts **plus every ancestor above them**, so a match
 * deep in the tree stays reachable instead of surfacing detached at the root.
 * Depths are untouched — a kept node is always still under its real parent.
 */
export function pruneFolderTree(
  nodes: FolderTreeNode[],
  keep: (folder: FolderMeta) => boolean,
): FolderTreeNode[] {
  const out: FolderTreeNode[] = [];
  for (const node of nodes) {
    const children = pruneFolderTree(node.children, keep);
    if (children.length === 0 && !keep(node.folder)) continue;
    out.push({ ...node, children });
  }
  return out;
}

/** Every folder id in this subtree (the node itself included). */
export function subtreeFolderIds(node: FolderTreeNode): string[] {
  const ids = [node.folder.id];
  for (const child of node.children) ids.push(...subtreeFolderIds(child));
  return ids;
}

/**
 * Ancestor names above a folder, outermost first — the「设计 / 图标」breadcrumb
 * pickers show so two folders named 图标 stay tellable apart.
 */
export function folderAncestorNames(folder: FolderMeta): string[] {
  const parentRel = normalizeRel(folder.parentRelPath);
  if (!parentRel) return [];
  return parentRel.split("/").filter(Boolean);
}

/**
 * Ids of the folders a target is nested inside, outermost first. Revealing a
 * folder in the rail has to open its ancestors too, or the row stays folded away
 * behind a collapsed parent.
 */
export function ancestorFolderIds(
  folders: FolderMeta[],
  folderId: string,
): string[] {
  const target = folders.find((f) => f.id === folderId);
  const parentRel = target ? normalizeRel(target.parentRelPath) : "";
  if (!parentRel) return [];
  const byRelPath = new Map<string, FolderMeta>();
  for (const f of folders) {
    const rel = normalizeRel(f.relPath);
    if (rel) byRelPath.set(rel, f);
  }
  const ids: string[] = [];
  const segments = parentRel.split("/").filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    const ancestor = byRelPath.get(segments.slice(0, i).join("/"));
    if (ancestor) ids.push(ancestor.id);
  }
  return ids;
}
