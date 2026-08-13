/**
 * 「用系统默认程序打开」的安全扩展名白名单（单一真相源）。
 *
 * 为什么放 shared：两端各按自己的策略消费**同一张表**，避免主进程强制面与 renderer 门控面
 * 漂移（对标 {@link ../shared/safe-url.ts} 的 openExternal 白名单）。
 * - **主进程**（`fs/execGate.ts`）：本地文件名单外 → native 确认后仍可开（用户自己的盘，
 *   可信度高）；`fs/openTemp.ts` 云端临时副本名单外 → **直接拒**，无确认逃生口。
 * - **renderer**（云端 `FileSource.canOpenWithOsDefaultApp`）：名单外不渲染入口。
 *
 * 两端策略不同是刻意的：本地文件的字节是用户自己放进去的，云端文件的字节是 **AI 产出**的，
 * 后者「弹框让用户点确认」不构成有效防线（用户会习惯性点是）。表共用、策略各表达。
 */

/**
 * 「已知安全、打开即查看不执行」的扩展名白名单（白名单姿态——红队 2026-06-30）。文档 / 媒体 /
 * 图片 / 纯文本数据 / 压缩包：用 OS 关联打开 = 走查看器，不会经文件关联执行代码。**刻意不含**
 * 脚本 / 源码（.js/.py/.ps1… 多数在 Windows 双击即被解释器执行）与宏启用文档（.docm/.xlsm…）。
 * 不在表内者一律走各自的拒绝策略——漏掉某个安全类型只是「多弹一次窗 / 少一个入口」（安全
 * 失败），绝不会「漏放一个危险类型」（黑名单通病）。
 */
export const SAFE_OPEN_EXTS: ReadonlySet<string> = new Set([
  // 纯文本 / 标记 / 数据 / 配置
  "txt",
  "text",
  "md",
  "markdown",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "rtf",
  // 文档（**不含**宏启用格式 docm/xlsm/pptm/xlsb）
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub",
  // 图片
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  // 音频
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "oga",
  "m4a",
  "opus",
  "wma",
  // 视频
  "mp4",
  "m4v",
  "mov",
  "avi",
  "mkv",
  "webm",
  "mpg",
  "mpeg",
  "wmv",
  "flv",
  // 压缩包（打开 = 进归档查看器，不执行内容）
  "zip",
  "gz",
  "tgz",
  "bz2",
  "tar",
  "7z",
  "rar",
  "xz",
  "zst",
]);

/** 路径 / 文件名的最后一段（容错两种分隔符）。 */
function baseName(pathOrName: string): string {
  return pathOrName.split(/[\\/]/).pop() ?? "";
}

/**
 * 该文件名是否属于「打开即查看不执行」的已知安全类型（纯函数、可单测）。
 *
 * 关键：先按 **Windows 的规矩**规整文件名再取扩展名——Windows 解析前会抹掉文件名末尾的点与
 * 空格（`evil.exe.` / `evil.exe ` 实际执行 `evil.exe`），故先 trim 末尾 `.`/空格再判，否则
 * 「假装无害」的名字会骗过分类（红队 E2）。规整后无明确扩展名（无扩展名 / dotfile）→ 不安全
 * （无法判定，安全失败）。
 */
export function isSafeOpenExt(pathOrName: string): boolean {
  const normalized = baseName(pathOrName).replace(/[ .]+$/, "");
  const dot = normalized.lastIndexOf(".");
  if (dot <= 0) return false; // 无明确扩展名 / dotfile → 无法判定安全
  return SAFE_OPEN_EXTS.has(normalized.slice(dot + 1).toLowerCase());
}
