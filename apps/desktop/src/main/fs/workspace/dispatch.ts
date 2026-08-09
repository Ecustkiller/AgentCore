import type { WorkspaceOpName, WorkspaceOpResult } from "@shared/ipc-contract";
import { logDesktop } from "../../log-service";
import {
  WINDOWS_RESERVED_DEVICE_REASON,
  pathHasWindowsReservedDeviceName,
  toReason,
} from "../pathGuard";
import type { StoredRoot } from "../roots";
import { ensureReady, getRoot } from "../roots";
import { opArchive } from "./archive";
import { opDiagnostics } from "./diagnostics";
import { opExecute } from "./exec";
import { probeAvailableLanguages } from "./execCodec";
import { opGitRepoStatus } from "./gitRepoStatus";
import { opGitRun } from "./gitRun";
import { opGitScm } from "./gitScm";
import { opGrep } from "./grep";
import {
  opProcessList,
  opProcessRead,
  opProcessStart,
  opProcessStop,
} from "./process";
import {
  opExists,
  opIndexFiles,
  opList,
  opListTree,
  opRead,
  opReadLines,
} from "./read";
import { opErr, opOk } from "./result";
import { opEnsureTurnBaseline } from "./turnBaseline";
import {
  opAppend,
  opCopy,
  opDelete,
  opMkdir,
  opMove,
  opReadBytes,
  opReplace,
  opWrite,
  opWriteBytes,
} from "./write";

/** Session-root access mode (W3 readonly / organize). Permanent roots have neither. */
export type SessionRootMode = "readonly" | "organize";

function normalizeRevealPaths(raw: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const p = item
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+|\/+$/g, "");
    if (p && p !== ".") out.add(p);
  }
  return out.size > 0 ? out : undefined;
}

const ORGANIZE_ALLOWED_OPS = new Set<WorkspaceOpName>([
  "read",
  "read_bytes",
  "read_lines",
  "list",
  "exists",
  "list_tree",
  "index_files",
  "grep",
  "probe_exec",
  "process_read",
  "process_list",
  "process_stop",
  "move",
  "copy",
  "mkdir",
  "delete",
  "diagnostics",
  "git_repo_status",
]);

const ORGANIZE_DENIED_OPS = new Set<WorkspaceOpName>([
  "write",
  "append",
  "write_bytes",
  "replace",
  "execute",
  "process_start",
  "archive",
  "ensure_turn_baseline",
  "git_scm",
  "git_run",
]);

const READONLY_MSG = "会话授权目录为只读，不能写入；请把产出写到对话工作区";
const ORGANIZE_DENY_MSG =
  "整理授权不允许此操作（仅 list/read/grep/stat + move/copy/mkdir + 回收站删除）";
const PERMANENT_EXTERNAL_MSG =
  "区外目录禁止永久删除；请使用可逆删除（进回收站）";

/** Collect path-like args for a reserved-device preflight (before any op touches disk). */
function pathArgsForReservedCheck(
  op: WorkspaceOpName,
  args: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v);
  };
  switch (op) {
    case "read":
    case "read_bytes":
    case "read_lines":
    case "write":
    case "append":
    case "write_bytes":
    case "exists":
    case "mkdir":
    case "delete":
    case "replace":
      push(args.path);
      break;
    case "list":
    case "list_tree":
      push(args.directory);
      break;
    case "index_files":
      push(args.base);
      break;
    case "copy":
    case "move":
      push(args.src);
      push(args.dst);
      break;
    case "grep":
      push(args.path);
      push(args.directory);
      break;
    case "execute":
    case "process_start":
      push(args.cwd);
      break;
    case "archive":
      push(args.directory);
      push(args.path);
      break;
    case "diagnostics":
      push(args.path);
      break;
    case "ensure_turn_baseline":
      push(args.directory);
      break;
    default:
      break;
  }
  return out;
}

/** First path arg that contains a Windows reserved device segment, or null. */
function firstReservedDevicePath(
  op: WorkspaceOpName,
  args: Record<string, unknown>,
): string | null {
  for (const p of pathArgsForReservedCheck(op, args)) {
    if (pathHasWindowsReservedDeviceName(p)) return p;
  }
  return null;
}

/** Resolve session-root mode (missing mode on sessionOnly → readonly). */
export function resolveSessionMode(root: StoredRoot): SessionRootMode | null {
  if (root.mode === "organize" || root.mode === "readonly") return root.mode;
  if (root.sessionOnly) return "readonly";
  return null;
}

/**
 * Mode + op whitelist for session external roots.
 * Returns an error envelope when denied; ``null`` when allowed (or not a session root).
 */
export function sessionRootAccessError(
  root: StoredRoot,
  op: WorkspaceOpName,
  args: Record<string, unknown>,
): WorkspaceOpResult | null {
  const mode = resolveSessionMode(root);
  if (mode === null) return null;

  if (mode === "readonly") {
    if (
      ORGANIZE_DENIED_OPS.has(op) ||
      op === "move" ||
      op === "copy" ||
      op === "mkdir" ||
      op === "delete"
    ) {
      return opErr("OutsideWorkspace", READONLY_MSG);
    }
    return null;
  }

  // organize
  if (op === "delete" && Boolean(args.permanent)) {
    return opErr("OutsideWorkspace", PERMANENT_EXTERNAL_MSG);
  }
  if (ORGANIZE_DENIED_OPS.has(op) || !ORGANIZE_ALLOWED_OPS.has(op)) {
    return opErr("OutsideWorkspace", ORGANIZE_DENY_MSG);
  }
  return null;
}

/** 主进程在飞 workspace op（leave-once：超时返回后即卸，底层 hung 不再永久占计数）。 */
let mainInflightTotal = 0;
const mainInflightByCid = new Map<string, number>();

export type WorkspaceOpMainReq = {
  rootId: string;
  op: WorkspaceOpName | string;
  timeoutMs?: number;
  /** 观测用：对齐服务端 workspace.op_timeout / 活性挂起。 */
  conversationId?: string;
  requestId?: string;
};

function mainInflightSnapshot(conversationId?: string): {
  inflight_total: number;
  inflight_cid: number | null;
  queue_depth: number;
} {
  const cid = conversationId?.trim() || "";
  return {
    inflight_total: mainInflightTotal,
    inflight_cid: cid ? (mainInflightByCid.get(cid) ?? 0) : null,
    // 桌面无真实排队闸：当前除自身外的在飞数 = 争用深度信号。
    queue_depth: Math.max(0, mainInflightTotal - 1),
  };
}

function enterMainInflight(conversationId?: string): {
  inflight_total: number;
  inflight_cid: number | null;
  queue_depth: number;
} {
  const queueDepth = mainInflightTotal;
  mainInflightTotal += 1;
  const cid = conversationId?.trim() || "";
  if (cid) {
    mainInflightByCid.set(cid, (mainInflightByCid.get(cid) ?? 0) + 1);
  }
  return {
    inflight_total: mainInflightTotal,
    inflight_cid: cid ? (mainInflightByCid.get(cid) ?? 0) : null,
    queue_depth: queueDepth,
  };
}

function leaveMainInflight(conversationId?: string): void {
  mainInflightTotal = Math.max(0, mainInflightTotal - 1);
  const cid = conversationId?.trim() || "";
  if (!cid) return;
  const n = (mainInflightByCid.get(cid) ?? 1) - 1;
  if (n <= 0) mainInflightByCid.delete(cid);
  else mainInflightByCid.set(cid, n);
}

/** Test-only: reset main-process inflight counters. */
export function resetWorkspaceOpMainInflightForTests(): void {
  mainInflightTotal = 0;
  mainInflightByCid.clear();
}

async function workspaceOp(req: {
  rootId: string;
  op: WorkspaceOpName;
  args: Record<string, unknown>;
  timeoutMs?: number;
  conversationId?: string;
  requestId?: string;
}): Promise<WorkspaceOpResult> {
  return runWorkspaceOpMain(req, async () => {
    await ensureReady();
    const root = getRoot(req.rootId);
    if (!root) return opErr("WorkspaceIOError", "本地目录未授权或已移除");
    return executeWorkspaceOp(root, req.op, req.args);
  });
}

/**
 * 主进程 workspaceOp 墙钟 + 观测（可单测：注入 `run` 模拟挂起 op）。
 * 有 `timeoutMs` 时 Promise.race；超时先回活性 IO 信封。
 *
 * 僵尸缓解：超时返回后立刻 leave inflight（leave-once），避免永不 settle 的底层
 * promise 永久占无界计数；底层仍可能继续跑（Win32 不可小改取消），但不再挡住观测面。
 */
export async function runWorkspaceOpMain(
  req: WorkspaceOpMainReq,
  run: () => Promise<WorkspaceOpResult>,
): Promise<WorkspaceOpResult> {
  const timeoutMs =
    typeof req.timeoutMs === "number" && req.timeoutMs > 0
      ? req.timeoutMs
      : undefined;
  const t0 = Date.now();
  const cid = req.conversationId?.trim() || undefined;
  const rid = req.requestId?.trim() || undefined;
  const enter = enterMainInflight(cid);
  const corr = {
    conversation_id: cid ?? null,
    request_id: rid ?? null,
  };
  logDesktop({
    level: "debug",
    event: "workspace_op.main_begin",
    fields: {
      op: req.op,
      root_id: req.rootId,
      timeout_ms: timeoutMs ?? null,
      ...corr,
      ...enter,
    },
  });
  let left = false;
  const leaveOnce = (): void => {
    if (left) return;
    left = true;
    leaveMainInflight(cid);
  };
  const opPromise = run().finally(leaveOnce);
  let result: WorkspaceOpResult;
  if (timeoutMs == null) {
    result = await opPromise;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        opPromise,
        new Promise<WorkspaceOpResult>((resolve) => {
          timer = setTimeout(() => {
            logDesktop({
              level: "warn",
              event: "workspace_op.main_timeout",
              fields: {
                op: req.op,
                root_id: req.rootId,
                timeout_ms: timeoutMs,
                duration_ms: Date.now() - t0,
                ...corr,
                ...mainInflightSnapshot(cid),
              },
            });
            // 超时先 leave，避免僵尸永久占 inflight（底层仍可能继续跑）。
            leaveOnce();
            resolve(
              opErr(
                "WorkspaceIOError",
                "本地工作区 op 活性挂起（主进程 timeout）",
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }
  logDesktop({
    level: result.ok ? "debug" : "warn",
    event: "workspace_op.main_end",
    fields: {
      op: req.op,
      root_id: req.rootId,
      timeout_ms: timeoutMs ?? null,
      duration_ms: Date.now() - t0,
      ok: result.ok,
      ...corr,
      ...mainInflightSnapshot(cid),
    },
  });
  return result;
}

/**
 * 在给定授权根上执行一次本地工作区 op。
 *
 * 与 electron / 根注册表解耦（只收一个 `StoredRoot`），故可脱离 Electron 直接单测。
 * 顶层 try 把任何 op 内未预期的异常兜底为 `WorkspaceIOError`，保证通道永远收到一个
 * 信封而非悬挂。
 */
export async function executeWorkspaceOp(
  root: StoredRoot,
  op: WorkspaceOpName,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  try {
    const denied = sessionRootAccessError(root, op, args);
    if (denied) return denied;
    const reserved = firstReservedDevicePath(op, args);
    if (reserved != null) {
      return opErr(
        "OutsideWorkspace",
        `${WINDOWS_RESERVED_DEVICE_REASON}：${reserved}`,
      );
    }
    switch (op) {
      case "read":
        return await opRead(root, String(args.path ?? ""));
      case "read_bytes":
        return await opReadBytes(root, String(args.path ?? ""));
      case "write":
        return await opWrite(
          root,
          String(args.path ?? ""),
          String(args.content ?? ""),
        );
      case "append":
        return await opAppend(
          root,
          String(args.path ?? ""),
          String(args.content ?? ""),
        );
      case "write_bytes":
        return await opWriteBytes(
          root,
          String(args.path ?? ""),
          String(args.data ?? ""),
        );
      case "list":
        return await opList(
          root,
          String(args.directory ?? "."),
          String(args.pattern ?? "*"),
          normalizeRevealPaths(args.reveal_paths),
          {
            revealArchives: Boolean(args.reveal_archives),
            externalNs: resolveSessionMode(root) !== null,
          },
        );
      case "exists":
        return await opExists(root, String(args.path ?? ""));
      case "read_lines":
        return await opReadLines(
          root,
          String(args.path ?? ""),
          Number(args.offset ?? 1),
          args.limit == null ? null : Number(args.limit),
        );
      case "list_tree":
        return await opListTree(
          root,
          String(args.directory ?? "."),
          String(args.pattern ?? "*"),
          Number(args.max_depth ?? 3),
          Number(args.max_entries ?? 200),
          normalizeRevealPaths(args.reveal_paths),
          {
            revealArchives: Boolean(args.reveal_archives),
            externalNs: resolveSessionMode(root) !== null,
          },
        );
      case "index_files":
        return await opIndexFiles(
          root,
          args.order === "recent" ? "recent" : "path",
          String(args.base ?? ""),
        );
      case "mkdir":
        return await opMkdir(root, String(args.path ?? ""));
      case "delete":
        return await opDelete(
          root,
          String(args.path ?? ""),
          Boolean(args.permanent),
        );
      case "copy":
        return await opCopy(
          root,
          String(args.src ?? ""),
          String(args.dst ?? ""),
        );
      case "move":
        return await opMove(
          root,
          String(args.src ?? ""),
          String(args.dst ?? ""),
        );
      case "replace":
        return await opReplace(
          root,
          String(args.path ?? ""),
          String(args.old ?? ""),
          String(args.new ?? ""),
          Boolean(args.all),
        );
      case "grep":
        return await opGrep(root, args);
      case "execute":
        return await opExecute(root, args);
      case "probe_exec":
        // PATH / Git Bash probe — independent of the bound root contents.
        return opOk({ languages: probeAvailableLanguages() });
      case "archive":
        return await opArchive(root, args);
      case "ensure_turn_baseline":
        return await opEnsureTurnBaseline(root, args);
      case "process_start":
        return await opProcessStart(root, args);
      case "process_read":
        return await opProcessRead(root, args);
      case "process_stop":
        return await opProcessStop(root, args);
      case "process_list":
        return await opProcessList(root, args);
      case "diagnostics":
        return await opDiagnostics(root, args);
      case "git_repo_status":
        return await opGitRepoStatus(root);
      case "git_scm":
        return await opGitScm(root, args);
      case "git_run":
        return await opGitRun(root, args);
      default:
        return opErr("WorkspaceIOError", `本地工作区未知的操作：${op}`);
    }
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}

export { workspaceOp };
