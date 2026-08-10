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

/**
 * 主进程物理并发上限（含 leave-once 后仍未 settle 的僵尸），对齐服务端
 * ``workspace_channel_max_inflight``。Admission 只看 physical_running，不看逻辑 leave-once。
 */
export const WORKSPACE_OP_MAIN_PHYSICAL_CAP = 16;

/** capacity ≠ liveness：禁止含「活性挂起」/「timed out」，避免误冲 sticky / 熔断 tally。 */
export function workspaceOpMainCapacityDetail(cap: number): string {
  return `本地工作区并发已满（物理上限 ${cap}），排队等待未获执行位`;
}

/** 逻辑在飞（leave-once：超时返回后即卸；观测用，不驱动 admission）。 */
let mainInflightTotal = 0;
const mainInflightByCid = new Map<string, number>();

/** 物理在飞：admit 时 +1，底层 promise finally 才 −1（超时不减 → 僵尸仍占槽）。 */
let physicalRunning = 0;
/** 已超时 leave-once、底层尚未 finally 的物理占槽数。 */
let zombieCount = 0;
let physicalCapOverride: number | null = null;

type PhysicalWaiter = {
  resolve: (admitted: boolean) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const physicalWaiters: PhysicalWaiter[] = [];

export type WorkspaceOpMainReq = {
  rootId: string;
  op: WorkspaceOpName | string;
  timeoutMs?: number;
  /** 观测用：对齐服务端 workspace.op_timeout / 活性挂起。 */
  conversationId?: string;
  requestId?: string;
};

function currentPhysicalCap(): number {
  return physicalCapOverride ?? WORKSPACE_OP_MAIN_PHYSICAL_CAP;
}

function mainInflightSnapshot(conversationId?: string): {
  inflight_total: number;
  inflight_cid: number | null;
  queue_depth: number;
  physical_running: number;
  zombie_count: number;
  cap: number;
} {
  const cid = conversationId?.trim() || "";
  return {
    inflight_total: mainInflightTotal,
    inflight_cid: cid ? (mainInflightByCid.get(cid) ?? 0) : null,
    queue_depth: physicalWaiters.length,
    physical_running: physicalRunning,
    zombie_count: zombieCount,
    cap: currentPhysicalCap(),
  };
}

function enterMainInflight(conversationId?: string): void {
  mainInflightTotal += 1;
  const cid = conversationId?.trim() || "";
  if (cid) {
    mainInflightByCid.set(cid, (mainInflightByCid.get(cid) ?? 0) + 1);
  }
}

function leaveMainInflight(conversationId?: string): void {
  mainInflightTotal = Math.max(0, mainInflightTotal - 1);
  const cid = conversationId?.trim() || "";
  if (!cid) return;
  const n = (mainInflightByCid.get(cid) ?? 1) - 1;
  if (n <= 0) mainInflightByCid.delete(cid);
  else mainInflightByCid.set(cid, n);
}

function releasePhysicalSlot(): void {
  const next = physicalWaiters.shift();
  if (next) {
    if (next.timer != null) clearTimeout(next.timer);
    // 槽位转交：physicalRunning 不变。
    next.resolve(true);
    return;
  }
  physicalRunning = Math.max(0, physicalRunning - 1);
}

/**
 * 获取物理槽。满则排队；`deadlineMs` 耗尽 → 不占槽、返回 false（capacity fail）。
 * 无 deadline 时一直等到有槽。
 */
function acquirePhysicalSlot(
  deadlineMs: number | undefined,
  onQueued?: () => void,
): Promise<{
  admitted: boolean;
  queueWaitMs: number;
}> {
  const waitStarted = Date.now();
  if (physicalRunning < currentPhysicalCap()) {
    physicalRunning += 1;
    return Promise.resolve({ admitted: true, queueWaitMs: 0 });
  }
  return new Promise((resolve) => {
    const waiter: PhysicalWaiter = {
      resolve: (admitted) => {
        resolve({
          admitted,
          queueWaitMs: Date.now() - waitStarted,
        });
      },
      timer: undefined,
    };
    physicalWaiters.push(waiter);
    onQueued?.();
    if (deadlineMs != null) {
      const remaining = Math.max(0, deadlineMs);
      waiter.timer = setTimeout(() => {
        const idx = physicalWaiters.indexOf(waiter);
        if (idx >= 0) physicalWaiters.splice(idx, 1);
        waiter.resolve(false);
      }, remaining);
    }
  });
}

/** Test-only: reset main-process logical + physical admission state. */
export function resetWorkspaceOpMainInflightForTests(): void {
  mainInflightTotal = 0;
  mainInflightByCid.clear();
  physicalRunning = 0;
  zombieCount = 0;
  physicalCapOverride = null;
  while (physicalWaiters.length > 0) {
    const w = physicalWaiters.shift();
    if (!w) break;
    if (w.timer != null) clearTimeout(w.timer);
    w.resolve(false);
  }
}

/** Test-only: override physical CAP（null = 恢复默认 16）。 */
export function setWorkspaceOpMainPhysicalCapForTests(
  cap: number | null,
): void {
  physicalCapOverride = cap == null ? null : Math.max(1, Math.floor(cap));
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
 * 主进程 workspaceOp：物理 CAP 闸 + 墙钟 + 观测（可单测：注入 `run` 模拟挂起）。
 *
 * Admission 看 physical_running（含僵尸）；超限排队，排队耗尽 deadline → capacity
 * fail-settle（文案 ≠ 活性）。有 `timeoutMs` 时 Promise.race；超时 leave-once 卸逻辑
 * 计数并 zombie_enter，底层 finally 才放物理槽（zombie_end）。
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
  const corr = {
    conversation_id: cid ?? null,
    request_id: rid ?? null,
  };
  const baseFields = {
    op: req.op,
    root_id: req.rootId,
    timeout_ms: timeoutMs ?? null,
    ...corr,
  };

  const queueDeadlineMs =
    timeoutMs == null ? undefined : Math.max(0, timeoutMs - (Date.now() - t0));
  const slot = await acquirePhysicalSlot(queueDeadlineMs, () => {
    logDesktop({
      level: "debug",
      event: "workspace_op.queued",
      fields: {
        ...baseFields,
        ...mainInflightSnapshot(cid),
      },
    });
  });
  if (!slot.admitted) {
    const detail = workspaceOpMainCapacityDetail(currentPhysicalCap());
    logDesktop({
      level: "warn",
      event: "workspace_op.rejected_capacity",
      fields: {
        ...baseFields,
        duration_ms: Date.now() - t0,
        queue_wait_ms: slot.queueWaitMs,
        ...mainInflightSnapshot(cid),
      },
    });
    logDesktop({
      level: "warn",
      event: "workspace_op.main_end",
      fields: {
        ...baseFields,
        duration_ms: Date.now() - t0,
        ok: false,
        capacity: true,
        queue_wait_ms: slot.queueWaitMs,
        ...mainInflightSnapshot(cid),
      },
    });
    return opErr("WorkspaceIOError", detail);
  }

  const remainingAfterAdmit =
    timeoutMs == null ? undefined : Math.max(0, timeoutMs - (Date.now() - t0));
  // 排队已吃光墙钟：不启动 op，立刻放槽 + capacity fail（≠ 活性）。
  if (remainingAfterAdmit === 0) {
    releasePhysicalSlot();
    const detail = workspaceOpMainCapacityDetail(currentPhysicalCap());
    logDesktop({
      level: "warn",
      event: "workspace_op.rejected_capacity",
      fields: {
        ...baseFields,
        duration_ms: Date.now() - t0,
        queue_wait_ms: slot.queueWaitMs,
        reason: "deadline_exhausted_at_admit",
        ...mainInflightSnapshot(cid),
      },
    });
    logDesktop({
      level: "warn",
      event: "workspace_op.main_end",
      fields: {
        ...baseFields,
        duration_ms: Date.now() - t0,
        ok: false,
        capacity: true,
        queue_wait_ms: slot.queueWaitMs,
        ...mainInflightSnapshot(cid),
      },
    });
    return opErr("WorkspaceIOError", detail);
  }

  logDesktop({
    level: "debug",
    event: "workspace_op.admitted",
    fields: {
      ...baseFields,
      queue_wait_ms: slot.queueWaitMs,
      ...mainInflightSnapshot(cid),
    },
  });

  enterMainInflight(cid);
  logDesktop({
    level: "debug",
    event: "workspace_op.main_begin",
    fields: {
      ...baseFields,
      queue_wait_ms: slot.queueWaitMs,
      ...mainInflightSnapshot(cid),
    },
  });

  let left = false;
  let becameZombie = false;
  const leaveOnce = (): void => {
    if (left) return;
    left = true;
    leaveMainInflight(cid);
  };
  const opPromise = run().finally(() => {
    leaveOnce();
    if (becameZombie) {
      zombieCount = Math.max(0, zombieCount - 1);
      logDesktop({
        level: "debug",
        event: "workspace_op.zombie_end",
        fields: {
          ...baseFields,
          duration_ms: Date.now() - t0,
          ...mainInflightSnapshot(cid),
        },
      });
    }
    releasePhysicalSlot();
  });

  let result: WorkspaceOpResult;
  if (remainingAfterAdmit == null) {
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
                ...baseFields,
                timeout_ms: timeoutMs,
                duration_ms: Date.now() - t0,
                ...mainInflightSnapshot(cid),
              },
            });
            // 超时先 leave 逻辑计数；物理槽仍由底层 finally 释放（僵尸占槽）。
            leaveOnce();
            becameZombie = true;
            zombieCount += 1;
            logDesktop({
              level: "warn",
              event: "workspace_op.zombie_enter",
              fields: {
                ...baseFields,
                duration_ms: Date.now() - t0,
                ...mainInflightSnapshot(cid),
              },
            });
            resolve(
              opErr(
                "WorkspaceIOError",
                "本地工作区 op 活性挂起（主进程 timeout）",
              ),
            );
          }, remainingAfterAdmit);
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
      ...baseFields,
      duration_ms: Date.now() - t0,
      ok: result.ok,
      queue_wait_ms: slot.queueWaitMs,
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
