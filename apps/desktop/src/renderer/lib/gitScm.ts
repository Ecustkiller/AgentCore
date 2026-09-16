/**
 * U3：用户 SCM 动作 —— 经 ``workspaceOp('git_scm')``；
 * push/pull/discard 在调用前恒确认（对等结构化 git 审批卡）；fetch 免确认。
 */
import { notifyActionError } from "@/lib/toast";

export const GIT_PUSH_CONFIRM =
  "将推送当前功能分支到 remote（禁止 force / 禁止从 main·master 直推）。确定继续？";

export const GIT_PULL_CONFIRM =
  "将以快进方式拉取（固定 --ff-only）。非快进或冲突会失败，需打开文件手动处理。确定继续？";

export const GIT_DISCARD_CONFIRM =
  "将丢弃该文件的未暂存改动（恢复为暂存区/索引中的内容，不是上次提交）。此操作不可撤销。确定继续？";

export type GitScmAction =
  | "stage"
  | "unstage"
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "diff"
  | "discard";

export interface GitScmResult {
  ok: true;
  detail?: string;
  text?: string;
}

function withDeskCwd(
  args: Record<string, unknown>,
  cwd?: string,
): Record<string, unknown> {
  const sub = (cwd ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  return sub ? { ...args, cwd: sub } : args;
}

function errDetail(res: {
  ok: false;
  error: { kind: string; detail: string };
}): string {
  return res.error.detail || res.error.kind;
}

export async function runGitScm(
  rootId: string,
  action: GitScmAction,
  args: Record<string, unknown> = {},
): Promise<GitScmResult | { ok: false; detail: string }> {
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.workspaceOp) {
    return { ok: false, detail: "本地工作区不可用" };
  }
  try {
    const res = await fsApi.workspaceOp(rootId, "git_scm", {
      action,
      ...args,
    });
    if (!res.ok) return { ok: false, detail: errDetail(res) };
    const value = (res.value ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      detail: typeof value.detail === "string" ? value.detail : undefined,
      text: typeof value.text === "string" ? value.text : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** stage 指定路径（空 = 全部）。 */
export async function gitStage(
  rootId: string,
  paths?: string[],
  cwd?: string,
): Promise<boolean> {
  const r = await runGitScm(
    rootId,
    "stage",
    withDeskCwd(
      {
        paths: paths && paths.length > 0 ? paths : undefined,
      },
      cwd,
    ),
  );
  if (!r.ok) {
    notifyActionError("暂存失败", r.detail);
    return false;
  }
  return true;
}

export async function gitUnstage(
  rootId: string,
  paths?: string[],
  cwd?: string,
): Promise<boolean> {
  const r = await runGitScm(
    rootId,
    "unstage",
    withDeskCwd(
      {
        paths: paths && paths.length > 0 ? paths : undefined,
      },
      cwd,
    ),
  );
  if (!r.ok) {
    notifyActionError("取消暂存失败", r.detail);
    return false;
  }
  return true;
}

export async function gitCommit(
  rootId: string,
  message: string,
  cwd?: string,
): Promise<boolean> {
  const r = await runGitScm(rootId, "commit", withDeskCwd({ message }, cwd));
  if (!r.ok) {
    notifyActionError("提交失败", r.detail);
    return false;
  }
  return true;
}

/** push：恒确认；取消返回 false。 */
export async function gitPush(
  rootId: string,
  opts?: { remote?: string; setUpstream?: boolean; cwd?: string },
): Promise<boolean> {
  if (typeof window !== "undefined" && !window.confirm(GIT_PUSH_CONFIRM)) {
    return false;
  }
  const r = await runGitScm(
    rootId,
    "push",
    withDeskCwd(
      {
        remote: opts?.remote,
        set_upstream: opts?.setUpstream ?? true,
      },
      opts?.cwd,
    ),
  );
  if (!r.ok) {
    notifyActionError("推送失败", r.detail);
    return false;
  }
  return true;
}

/** pull：恒确认；ff-only。 */
export async function gitPull(
  rootId: string,
  opts?: { remote?: string; cwd?: string },
): Promise<boolean> {
  if (typeof window !== "undefined" && !window.confirm(GIT_PULL_CONFIRM)) {
    return false;
  }
  const r = await runGitScm(
    rootId,
    "pull",
    withDeskCwd({ remote: opts?.remote }, opts?.cwd),
  );
  if (!r.ok) {
    notifyActionError("拉取失败", r.detail);
    return false;
  }
  return true;
}

/** fetch：免确认；仅更新远端跟踪引用。 */
export async function gitFetch(
  rootId: string,
  opts?: { remote?: string; cwd?: string },
): Promise<boolean> {
  const r = await runGitScm(
    rootId,
    "fetch",
    withDeskCwd({ remote: opts?.remote }, opts?.cwd),
  );
  if (!r.ok) {
    notifyActionError("获取失败", r.detail);
    return false;
  }
  return true;
}

export async function gitDiffText(
  rootId: string,
  path: string,
  staged: boolean,
  cwd?: string,
): Promise<string | null> {
  const r = await runGitScm(rootId, "diff", withDeskCwd({ path, staged }, cwd));
  if (!r.ok) {
    notifyActionError("查看差异失败", r.detail);
    return null;
  }
  return r.text ?? "";
}

/**
 * 窄口丢弃未暂存工作区改动：恒确认；须指定 path(s)；不做 clean / 无路径整仓。
 */
export function gitDiscardConfirmMessage(count: number): string {
  if (count <= 1) return GIT_DISCARD_CONFIRM;
  return `将丢弃 ${count} 个文件的未暂存改动（恢复为暂存区/索引中的内容，不是上次提交）。此操作不可撤销。确定继续？`;
}

export async function gitDiscard(
  rootId: string,
  paths: string | string[],
  opts?: { skipConfirm?: boolean; cwd?: string },
): Promise<boolean> {
  const list = (Array.isArray(paths) ? paths : [paths])
    .map((p) => p.replace(/\\/g, "/").trim())
    .filter(Boolean);
  if (list.length === 0) return false;
  if (
    !opts?.skipConfirm &&
    typeof window !== "undefined" &&
    !window.confirm(gitDiscardConfirmMessage(list.length))
  ) {
    return false;
  }
  const r = await runGitScm(
    rootId,
    "discard",
    withDeskCwd({ paths: list }, opts?.cwd),
  );
  if (!r.ok) {
    notifyActionError("丢弃改动失败", r.detail);
    return false;
  }
  return true;
}

export const GIT_DELETE_UNTRACKED_CONFIRM =
  "将把该未跟踪文件移入系统回收站（不是 git clean）。确定继续？";

export function gitDeleteUntrackedConfirmMessage(count: number): string {
  if (count <= 1) return GIT_DELETE_UNTRACKED_CONFIRM;
  return `将把 ${count} 个未跟踪文件移入系统回收站（不是 git clean）。确定继续？`;
}

/** 删除未跟踪文件：走 trashPath（系统回收站），禁止 git clean。 */
export async function deleteUntrackedFiles(
  rootId: string,
  workspaceRelPaths: string[],
  opts?: { skipConfirm?: boolean; containerSubpath?: string },
): Promise<boolean> {
  const prefix = (opts?.containerSubpath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  const safe = workspaceRelPaths
    .map((p) => p.replace(/\\/g, "/").replace(/^\/+/, "").trim())
    .filter((p) => p.length > 0)
    .map((p) => (prefix ? `${prefix}/${p}` : p));
  if (safe.length === 0) {
    notifyActionError("删除失败", "无效路径");
    return false;
  }
  if (
    !opts?.skipConfirm &&
    typeof window !== "undefined" &&
    !window.confirm(gitDeleteUntrackedConfirmMessage(safe.length))
  ) {
    return false;
  }
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.trashPath) {
    notifyActionError("删除失败", "本地工作区不可用");
    return false;
  }
  for (const rel of safe) {
    try {
      const res = await fsApi.trashPath(rootId, rel);
      if (!res.ok) {
        notifyActionError("删除失败", res.reason || rel);
        return false;
      }
    } catch (e) {
      notifyActionError("删除失败", e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  return true;
}
