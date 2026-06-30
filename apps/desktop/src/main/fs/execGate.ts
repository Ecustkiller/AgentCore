/**
 * 危险原生出口的主进程侧确认门（IPC-001 / IPC-002 · 第五轮 IPC 权限面审计）。
 *
 * 背景：`fs:workspaceOp('execute')`（跑任意代码）与 `fs:openPath`（用 OS 关联打开——可执行
 * 类型 = 经文件关联执行）是「renderer 被攻破后直达宿主 RCE」的两个头。审批发生在 renderer +
 * 后端、**主进程不在审批环里**，故主进程分不清「批准后的合法调用」与「直接恶意调用」。
 *
 * 唯一 renderer **无法伪造**的门 = 主进程侧 native 确认（人决策 2026-06-30）。它是**叠加**层
 * （不动受 conformance 门禁的审批 fold），代价是合法的云端本地执行会在审批卡之外多弹一次主侧
 * 确认——这与后端 `code_execute` 的 PER_CALL / PI-004（注入内容不得搭便车）同一姿态：故 execute
 * **每次必弹、不记忆**。openPath 改用**白名单姿态**：仅「已知安全类型」（文档 / 媒体 / 图片 /
 * 文本 / 压缩包）直开零打扰，其余一律弹确认——黑名单永远列不全，且 Windows 会抹掉文件名末尾的
 * 点 / 空格使「假装无害」的名字仍被执行（红队 2026-06-30：E1 黑名单缺口 + E2 文件名归一化绕过）。
 *
 * 放在 IPC 缝（被 `fs/ipc.ts` 调用），不进 `opExecute`/`dispatch`（后者纯函数、被 headless 单测
 * 直接调，混入 dialog 会破坏可测性）。`requiresOpenConfirm` 为纯函数、单独可测。
 */
import { BrowserWindow, dialog } from "electron";

/**
 * 「已知安全、打开即查看不执行」的扩展名白名单（白名单姿态——红队 2026-06-30）。文档 / 媒体 /
 * 图片 / 纯文本数据 / 压缩包：用 OS 关联打开 = 走查看器，不会经文件关联执行代码。**刻意不含**
 * 脚本 / 源码（.js/.py/.ps1… 多数在 Windows 双击即被解释器执行）与宏启用文档（.docm/.xlsm…）。
 * 不在表内者一律弹确认（含未知扩展名 / 无扩展名 / 危险类型）——漏掉某个安全类型只是「多弹一次
 * 窗」（安全失败），绝不会「漏放一个危险类型」（黑名单通病）。
 */
const SAFE_OPEN_EXTS: ReadonlySet<string> = new Set([
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

/** relPath 的最后一段文件名（容错两种路径分隔符）。 */
function baseName(relPath: string): string {
  return relPath.split(/[\\/]/).pop() ?? "";
}

/**
 * 用 OS 默认程序打开此路径前是否需要主侧确认（纯函数、可单测）。
 *
 * 关键：先按 **Windows 的规矩**规整文件名再取扩展名——Windows 解析前会抹掉文件名末尾的点与
 * 空格（`evil.exe.` / `evil.exe ` 实际执行 `evil.exe`），故先 trim 末尾 `.`/空格再判，否则
 * 「假装无害」的名字会骗过分类（红队 E2）。规整后无明确扩展名（无扩展名 / dotfile）→ 需确认
 * （无法判定安全，安全失败）。仅当扩展名落在 {@link SAFE_OPEN_EXTS} 才静默直开。
 */
export function requiresOpenConfirm(relPath: string): boolean {
  const normalized = baseName(relPath).replace(/[ .]+$/, "");
  const dot = normalized.lastIndexOf(".");
  if (dot <= 0) return true; // 无明确扩展名 / dotfile → 无法判定安全 → 确认
  return !SAFE_OPEN_EXTS.has(normalized.slice(dot + 1).toLowerCase());
}

function activeWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  );
}

/** 主侧 native 确认对话框；默认 / 取消按钮均为「取消」（安全失败）。返回用户是否放行。 */
async function confirmDanger(opts: {
  message: string;
  detail: string;
  confirmLabel: string;
}): Promise<boolean> {
  const win = activeWindow();
  const box = {
    type: "warning" as const,
    buttons: ["取消", opts.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "AgentCore 安全确认",
    message: opts.message,
    detail: opts.detail,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, box)
    : await dialog.showMessageBox(box);
  return response === 1; // 仅「确认」按钮放行；关闭 / Esc → cancelId(0) → false
}

// 预览上限：够看清意图，又不把对话框撑爆。code 与 stdin 各自独立截断。
const PREVIEW_CAP = 2000;

/** 把单段输入截断到预览上限（够看清意图，又不撑爆对话框）。 */
function clip(s: string): string {
  return s.length > PREVIEW_CAP ? `${s.slice(0, PREVIEW_CAP)}\n…（已截断）` : s;
}

/**
 * execute 门：spawn 前确认（每次必弹，与后端 code_execute PER_CALL / PI-004 一致）。
 *
 * 展示**全部影响执行的输入**：除 code 外，`stdin` 也会被子进程读取（如 `exec(sys.stdin.read())`
 * / `bash` 从 stdin 读脚本），同属「影响执行的输入」，必须一并显示——否则把 payload 藏进 stdin，
 * 确认框只显示无害的 code 即可骗过人（红队 2026-06-30：E3 隐藏输入泄漏）。stdin 缺省时不显示该段，
 * 避免给常规执行添噪。
 */
export function confirmExecute(
  args: Record<string, unknown>,
): Promise<boolean> {
  const language = String(args.language ?? "python");
  const cwd = String(args.cwd ?? "");
  const code = String(args.code ?? "");
  const stdin = args.stdin == null ? "" : String(args.stdin);
  const sections = [`工作目录：${cwd || "（绑定根）"}`, "", clip(code) || "（空）"];
  if (stdin) sections.push("", "── 标准输入 stdin ──", clip(stdin));
  return confirmDanger({
    message: `即将在本机运行 ${language} 代码`,
    detail: sections.join("\n"),
    confirmLabel: "运行",
  });
}

/** openPath 门：打开「非已知安全类型」前确认（白名单姿态，见 {@link requiresOpenConfirm}）。 */
export function confirmOpenPath(relPath: string): Promise<boolean> {
  return confirmDanger({
    message: "即将用系统默认程序打开此文件",
    detail: `${baseName(relPath) || relPath}\n\n系统无法确认该类型是否安全——某些类型会在打开时执行代码。确认要继续打开吗？`,
    confirmLabel: "打开",
  });
}
