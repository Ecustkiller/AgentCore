/**
 * 统一文件源抽象（文件中枢统一 §二）。
 *
 * 文件页（本地 OS 根，经 `window.fsApi`）与对话工作区面板（服务端 REST，经
 * `services/workspace`）本质都是「一棵带预览 + 增删改的文件树」。`FileSource`
 * 是让**同一套树/预览组件**渲染任意一种的接缝：源暴露 read/list/CRUD 核心 +
 * 能力位（watch / transfer / snapshots / handoff），UI 据能力位决定挂哪些可选
 * 面，而非在组件里按源分支。
 *
 * 寻址一律**源内相对**：每个 path 都是相对源根的 POSIX（"/" 分隔）路径，根本身
 * 为 ""。具体源（WorkspaceSource / LocalRootSource）各自负责映射到其后端。
 */

/** 一次列举里的一个条目（树的某一层）。 */
export interface FileNode {
  /** 源内相对 POSIX 路径；根本身为 ""。 */
  path: string;
  /** 显示名 = path 的最后一段。 */
  name: string;
  isDir: boolean;
}

/** 一次「读以预览」的结果——两种后端能返回的并集（superset）。 */
export type FilePreviewResult =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; mime?: string; size?: number; reason?: string }
  | { kind: "too-large" };

/** 目录变更回调（仅当 `caps.watch` 为真时有意义）。 */
export type FileChangeHandler = (dir: string) => void;

/** 文件版本（写前 CAS 基线）：本地用 mtime，云端用 etag/updatedAt（P4）。 */
export type FileVersion = { mtimeMs?: number; etag?: string };
/** 编辑用编码；`gbk` 仅可读不可回写。 */
export type EditEncoding = "utf-8" | "utf-8-bom" | "gbk";
export type EditEol = "lf" | "crlf";

/** 「读以编辑」结果（源无关）：完整正文（`\n` 换行）+ 版本基线 + 原文编码/换行。 */
export interface FileEditDoc {
  text: string;
  version: FileVersion;
  encoding: EditEncoding;
  eol: EditEol;
}

/** 写文本结果（源无关）。`conflict` 携磁盘/远端当前版本，供「仍然覆盖」用其做基线再写。 */
export type WriteTextResult =
  | { ok: true; version: FileVersion }
  | { ok: false; reason: "conflict"; version: FileVersion }
  | {
      ok: false;
      reason: "denied" | "locked" | "unsupported" | "error";
      message?: string;
    };

/**
 * 核心之外的可选能力。共用 UI 读这些决定挂哪些操作面（组件内不按源分支）。
 */
export interface FileSourceCaps {
  /** 推送目录变更事件（本地 FS watch）；否则 UI 走手动刷新。 */
  watch: boolean;
  /** 字节跨边界传输，故上传/下载有意义（云端工作区）。 */
  transfer: boolean;
  /** 面板内文本编辑经 `writeBytes` 回写。 */
  edit: boolean;
  /** 轴3 快照（备份 / 版本 / 恢复）对该源可用。 */
  snapshots: boolean;
  /** 云端交接（PR 三方评审）对该源可用。 */
  handoff: boolean;
}

export interface FileSource {
  /** 稳定标识（拖拽载荷限定 + 每源折叠态持久化键）。 */
  readonly id: string;
  /** 人类可读的根标签（项目 / 文件夹名）。 */
  readonly label: string;
  readonly caps: FileSourceCaps;

  /** 列举一个目录的直接子项（`dir` 为 "" 即根）。 */
  listDir(dir: string): Promise<FileNode[]>;
  /**
   * 把整棵子树作为扁平数组列出（递归）。仅「能廉价枚举全部」的源提供（服务端
   * 工作区）；用于一次性建树 + 全部展开/折叠。懒加载源省略它（UI 回退到展开时
   * 逐目录 `listDir`）。
   */
  listTree?(): Promise<FileNode[]>;
  /**
   * 扁平**文件**路径列表，喂给 @ 提及索引（文件中枢统一 F4）。只含文件（不含目录）、
   * 剪掉忽略目录（node_modules/.git…）、有上限——本地根经 `fsApi.listFiles`、云端
   * 工作区经 `/file-index`，二者语义对齐，故 @ 无论源是本地还是云端表现一致。能
   * 廉价枚举的源才提供；缺省即不参与 @ 索引。
   */
  listFileIndex?(): Promise<string[]>;

  /** 读一个文件用于面板内预览（传输失败抛异常）。 */
  read(path: string): Promise<FilePreviewResult>;

  /** 在 `path` 建一个空文件。 */
  createFile(path: string): Promise<void>;
  /** 在 `path` 建目录（按需建父级）。 */
  mkdir(path: string): Promise<void>;
  /** 把 `src` 移动/改名到完整目标路径 `dst`。 */
  move(src: string, dst: string): Promise<void>;
  /** 删除文件或目录（目录递归）。 */
  delete(path: string): Promise<void>;

  /**
   * 读一个文本文件用于**编辑**（完整正文 + 版本基线 + 编码/换行）。仅当 `caps.edit`
   * 且源支持源码编辑（本地 IPC；云端 P4）。与 `read`（预览，可能截断）分工——宿主
   * 编辑器只认这层接口，不分支本地/云端。
   */
  readForEdit?(path: string): Promise<FileEditDoc>;
  /**
   * 把编辑器正文写回 `path`，带写前 CAS（`baseline` 版本，`null` 视为新建）。仅当
   * `caps.edit`。失败以判别式 `reason` 返回（`conflict` 携当前版本），不抛异常。
   */
  writeText?(
    path: string,
    input: {
      content: string;
      encoding: EditEncoding;
      eol: EditEol;
      baseline: FileVersion | null;
    },
  ): Promise<WriteTextResult>;

  /** 写原始字节到 `path`（建/覆盖）。仅当 `caps.edit || caps.transfer`。 */
  writeBytes?(path: string, body: Blob): Promise<void>;
  /** 经浏览器把 `path` 存到用户磁盘。仅当 `caps.transfer`。 */
  download?(path: string, filename: string): Promise<void>;
  /** 订阅 `dir` 下变更；返回退订函数。仅当 `caps.watch`。 */
  watch?(dir: string, onChange: FileChangeHandler): () => void;
}

/** POSIX 源路径的最后一段（显示名）。 */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** POSIX 源路径的父目录（顶层条目为 ""）。 */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/** 把父目录与子名拼成源路径（dir 为 "" → 裸名）。 */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
