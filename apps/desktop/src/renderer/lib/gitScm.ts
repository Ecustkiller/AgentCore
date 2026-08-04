/**
 * U3：用户 SCM 动作 —— 经 ``workspaceOp('git_scm')``；
 * push/pull 在调用前恒确认（对等结构化 git 审批卡）。
 */
import { notifyActionError, notifySuccess } from "@/lib/toast";

export const GIT_PUSH_CONFIRM =
  "将推送当前功能分支到 remote（禁止 force / 禁止从 main·master 直推）。确定继续？";

export const GIT_PULL_CONFIRM =
  "将以快进方式拉取（固定 --ff-only）。非快进或冲突会失败，需打开文件手动处理。确定继续？";

export type GitScmAction =
  | "stage"
  | "unstage"
  | "commit"
  | "push"
  | "pull"
  | "diff";

export interface GitScmResult {
  ok: true;
  detail?: string;
  text?: string;
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

/** stage 指定路径（空 = 全部）。成功后 toast。 */
export async function gitStage(
  rootId: string,
  paths?: string[],
): Promise<boolean> {
  const r = await runGitScm(rootId, "stage", {
    paths: paths && paths.length > 0 ? paths : undefined,
  });
  if (!r.ok) {
    notifyActionError("暂存失败", r.detail);
    return false;
  }
  return true;
}

export async function gitUnstage(
  rootId: string,
  paths?: string[],
): Promise<boolean> {
  const r = await runGitScm(rootId, "unstage", {
    paths: paths && paths.length > 0 ? paths : undefined,
  });
  if (!r.ok) {
    notifyActionError("取消暂存失败", r.detail);
    return false;
  }
  return true;
}

export async function gitCommit(
  rootId: string,
  message: string,
): Promise<boolean> {
  const r = await runGitScm(rootId, "commit", { message });
  if (!r.ok) {
    notifyActionError("提交失败", r.detail);
    return false;
  }
  notifySuccess("已提交");
  return true;
}

/** push：恒确认；取消返回 false。 */
export async function gitPush(
  rootId: string,
  opts?: { remote?: string; setUpstream?: boolean },
): Promise<boolean> {
  if (typeof window !== "undefined" && !window.confirm(GIT_PUSH_CONFIRM)) {
    return false;
  }
  const r = await runGitScm(rootId, "push", {
    remote: opts?.remote,
    set_upstream: opts?.setUpstream ?? true,
  });
  if (!r.ok) {
    notifyActionError("推送失败", r.detail);
    return false;
  }
  notifySuccess(r.detail?.split("\n")[0] || "已推送");
  return true;
}

/** pull：恒确认；ff-only。 */
export async function gitPull(
  rootId: string,
  opts?: { remote?: string },
): Promise<boolean> {
  if (typeof window !== "undefined" && !window.confirm(GIT_PULL_CONFIRM)) {
    return false;
  }
  const r = await runGitScm(rootId, "pull", { remote: opts?.remote });
  if (!r.ok) {
    notifyActionError("拉取失败", r.detail);
    return false;
  }
  notifySuccess(r.detail?.split("\n")[0] || "已拉取");
  return true;
}

export async function gitDiffText(
  rootId: string,
  path: string,
  staged: boolean,
): Promise<string | null> {
  const r = await runGitScm(rootId, "diff", { path, staged });
  if (!r.ok) {
    notifyActionError("查看差异失败", r.detail);
    return null;
  }
  return r.text ?? "";
}
