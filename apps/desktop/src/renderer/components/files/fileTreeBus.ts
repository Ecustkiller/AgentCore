/**
 * 「某个源的某一层变了」广播。
 *
 * 一次跨源搬运会同时改**两棵**树，而发起方只握着自己那棵的 reload。挂载着的其它树订阅
 * 这个总线，收到自己源的通知就重拉那一层；没挂载的树无需处理——它下次展开本就会拉。
 */

export interface FileTreeChange {
  /** 变的是哪棵树。 */
  sourceId: string;
  /** 变了的那一层（该源内的相对目录，`""` = 根）。 */
  dir: string;
  /**
   * 从这棵树里被搬走的路径。它的选区还指着这些行，留着就等于让下一次删除对着不存在的
   * 路径开火，故收到通知的树要把它们（连同后代）摘掉。
   */
  movedAway?: readonly string[];
}

export type FileTreeChangeListener = (change: FileTreeChange) => void;

const listeners = new Set<FileTreeChangeListener>();

export function notifyFileTreeChanged(change: FileTreeChange): void {
  for (const listener of listeners) listener(change);
}

export function subscribeFileTreeChanged(
  listener: FileTreeChangeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
