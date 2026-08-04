/**
 * U1/U2 Git 只读状态 —— renderer 侧拉取。
 * 数据经 ``workspaceOp('git_repo_status')``；无仓 / 无 root / 失败 → null（不挂 chip / git 轨）。
 */
import type { GitChangeEntry, GitRepoStatusValue } from "@shared/ipc-contract";

export type PresentGitRepoStatus = Extract<
  GitRepoStatusValue,
  { present: true }
> & {
  ahead: number;
  behind: number;
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  conflicted: string[];
};

function isGitRepoStatusValue(v: unknown): v is GitRepoStatusValue {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.present === false) return true;
  return (
    o.present === true &&
    typeof o.branch === "string" &&
    typeof o.dirty === "boolean"
  );
}

function normalizePresent(
  v: Extract<GitRepoStatusValue, { present: true }>,
): PresentGitRepoStatus {
  return {
    present: true,
    branch: v.branch,
    dirty: v.dirty,
    ahead: typeof v.ahead === "number" ? v.ahead : 0,
    behind: typeof v.behind === "number" ? v.behind : 0,
    staged: Array.isArray(v.staged) ? v.staged : [],
    unstaged: Array.isArray(v.unstaged) ? v.unstaged : [],
    conflicted: Array.isArray(v.conflicted) ? v.conflicted : [],
  };
}

/** 拉取工作区根 Git 摘要；不可用时返回 null（UI 不显示）。 */
export async function fetchGitRepoStatus(
  rootId: string,
): Promise<PresentGitRepoStatus | null> {
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.workspaceOp) return null;
  try {
    const res = await fsApi.workspaceOp(rootId, "git_repo_status", {});
    if (!res.ok || !isGitRepoStatusValue(res.value)) return null;
    if (!res.value.present) return null;
    return normalizePresent(res.value);
  } catch {
    return null;
  }
}

/** 是否有值得挂「改动」git 轨的内容（脏 / 冲突 / ahead / behind）。 */
export function gitTrackHasWork(status: PresentGitRepoStatus | null): boolean {
  if (!status) return false;
  if (status.dirty) return true;
  if (status.conflicted.length > 0) return true;
  if (status.ahead > 0 || status.behind > 0) return true;
  return false;
}
