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

/**
 * 本地工作区 op 名（双模式工作区 P2）—— 与服务端 `WorkspaceOp` 一一对应。
 *
 * 服务端 `LocalWorkspace` 把每个 backend 方法序列化成一条 op 经 SSE 下发，主进程
 * 在授权根上执行后回填。P2a 先打通只读三件套（read/list/grep）。
 *
 * `archive` 不对应任何 backend 方法——它是本地→云交接（P2e / e1）专用 op：把整个绑定
 * 根打包成单个归档（套用忽略规则）交服务端暂存并快照，由 handoff 编排直接下发。
 */
export type WorkspaceOpName =
  | "read"
  | "write"
  | "read_bytes"
  | "write_bytes"
  | "list"
  | "mkdir"
  | "delete"
  | "move"
  | "replace"
  | "grep"
  | "execute"
  | "archive";

/**
 * 一次本地 op 的执行结果信封 —— 形状与服务端回填端点 `ResolveWorkspaceOpRequest`
 * 对齐：成功带 `value`（op 相关）；失败带类型化 `error`，其 `kind` 直接映射回服务端
 * 的 `WorkspaceError` 子类（如 `PathNotFound`），从而工具层报错文案与云模式一致。
 */
export type WorkspaceOpResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: string; detail: string; count?: number } };

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
  workspaceOp: "fs:workspaceOp",
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
  /**
   * 在某授权根上执行一次本地工作区 op（供本地模式下 AI 工具调用回填）。
   *
   * `args` 为该 op 的相对路径载荷（如 `{ path }` / `{ directory, pattern }`）；
   * 失败不抛异常，统一以 `WorkspaceOpResult` 的类型化 `error` 返回。
   */
  workspaceOp(
    rootId: string,
    op: WorkspaceOpName,
    args: Record<string, unknown>,
  ): Promise<WorkspaceOpResult>;
}
