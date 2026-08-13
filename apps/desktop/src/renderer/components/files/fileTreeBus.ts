/**
 * 「某个源的某一层变了」广播。
 *
 * 一次跨源搬运会同时改**两棵**树，而发起方只握着自己那棵的 reload。挂载着的其它树订阅
 * 这个总线，收到自己源的通知就重拉那一层；没挂载的树无需处理——它下次展开本就会拉。
 */

export type FileTreeChangeListener = (sourceId: string, dir: string) => void;

const listeners = new Set<FileTreeChangeListener>();

export function notifyFileTreeChanged(sourceId: string, dir: string): void {
  for (const listener of listeners) listener(sourceId, dir);
}

export function subscribeFileTreeChanged(
  listener: FileTreeChangeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
