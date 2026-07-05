import type { WorkspaceOpName, WorkspaceOpResult } from "@shared/ipc-contract";
import { toReason } from "../pathGuard";
import type { StoredRoot } from "../roots";
import { ensureReady, getRoot } from "../roots";
import { opArchive } from "./archive";
import { opExecute } from "./exec";
import { opGrep } from "./grep";
import { opIndexFiles, opList, opListTree, opRead, opReadLines } from "./read";
import { opErr } from "./result";
import {
  opDelete,
  opMkdir,
  opMove,
  opAppend,
  opReadBytes,
  opReplace,
  opWrite,
  opWriteBytes,
} from "./write";

async function workspaceOp(req: {
  rootId: string;
  op: WorkspaceOpName;
  args: Record<string, unknown>;
}): Promise<WorkspaceOpResult> {
  await ensureReady();
  const root = getRoot(req.rootId);
  if (!root) return opErr("WorkspaceIOError", "本地目录未授权或已移除");
  return executeWorkspaceOp(root, req.op, req.args);
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
        );
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
        return await opDelete(root, String(args.path ?? ""));
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
      case "archive":
        return await opArchive(root, args);
      default:
        return opErr("WorkspaceIOError", `本地工作区未知的操作：${op}`);
    }
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}

export { workspaceOp };
