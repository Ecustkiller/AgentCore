/**
 * 本地文件系统 IPC 契约 —— 主进程 / preload / renderer 三端共享的单一真相源。
 *
 * 设计约束：
 * - renderer 仅以 `{ rootId, relPath }` 寻址，绝对路径只存在于主进程（不下发本机绝对路径）。
 * - 所有可能失败的操作统一返回 `FsResult`（判别结果），不向 renderer 抛异常。
 */

/** 一个已授权的本地根目录（对 renderer 只暴露 id 与显示名）。 */
export interface FsRoot {
  id: string;
  name: string;
}

/** 目录项（懒加载的单层子项）。 */
export interface FsEntry {
  name: string;
  /** 相对所属根目录的路径，统一用 "/" 分隔；根目录自身为 ""。 */
  relPath: string;
  kind: "file" | "dir";
  /** 文件字节数；目录为 null。 */
  size: number | null;
  /** 最近修改时间（毫秒时间戳）；不可得为 null。 */
  modifiedMs: number | null;
}

/** 文件预览结果：文本 / 图片（data URL）/ 二进制（仅元信息）。 */
export type FilePreview =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; mime: string; size: number; reason: string };

/** 扁平文件条目（用于 @ 提及检索；只含文件，不含目录）。 */
export interface FsFileRef {
  /** 相对所属根目录的路径，统一用 "/" 分隔。 */
  relPath: string;
  /** 文件名（relPath 的最后一段）。 */
  name: string;
}

/** 统一的判别式结果。 */
export type FsResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

export type FsCreateKind = "file" | "dir";

/** 主进程 → renderer 的目录变更事件（watch 命中后发出）。 */
export interface FsChangedEvent {
  rootId: string;
  relPath: string;
}

/** IPC 通道名 —— 主进程与 preload 共用，避免硬编码漂移。 */
export const FS_CHANNELS = {
  addRoot: "fs:addRoot",
  listRoots: "fs:listRoots",
  removeRoot: "fs:removeRoot",
  listDir: "fs:listDir",
  listFiles: "fs:listFiles",
  readFile: "fs:readFile",
  rename: "fs:rename",
  move: "fs:move",
  create: "fs:create",
  delete: "fs:delete",
  watch: "fs:watch",
  unwatch: "fs:unwatch",
  changed: "fs:changed",
} as const;

/**
 * 暴露在 `window.fsApi` 上的 renderer 端 API 面。
 *
 * `move` 的 `destRelPath` 语义为「目标目录」，源对象将被移动进该目录。
 */
export interface FsApi {
  addRoot(): Promise<FsRoot | null>;
  listRoots(): Promise<FsRoot[]>;
  removeRoot(rootId: string): Promise<void>;
  listDir(rootId: string, relPath: string): Promise<FsResult<FsEntry[]>>;
  /** 递归列出根内的全部文件（用于 @ 提及检索；忽略常见无关目录，有数量上限）。 */
  listFiles(rootId: string): Promise<FsResult<FsFileRef[]>>;
  readFile(rootId: string, relPath: string): Promise<FsResult<FilePreview>>;
  rename(rootId: string, relPath: string, newName: string): Promise<FsResult>;
  move(
    rootId: string,
    srcRelPath: string,
    destRelPath: string,
  ): Promise<FsResult>;
  create(
    rootId: string,
    relPath: string,
    kind: FsCreateKind,
  ): Promise<FsResult>;
  delete(rootId: string, relPath: string): Promise<FsResult>;
  watch(rootId: string, relPath: string): Promise<void>;
  unwatch(rootId: string, relPath: string): Promise<void>;
  /** 订阅目录变更；返回取消订阅函数。 */
  onChanged(cb: (e: FsChangedEvent) => void): () => void;
}
