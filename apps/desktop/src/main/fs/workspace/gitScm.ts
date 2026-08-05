/**
 * U3：用户 SCM 受控 git（stage/unstage/commit/push/pull/fetch/diff/discard）。
 * 与结构化 ``git`` 同口径护栏：push 禁 force / 保护分支；pull 固定 --ff-only；
 * fetch 仅更新远端跟踪引用（无 force/prune/refspec 旋钮）；
 * discard 仅 ``restore --worktree``（须指定 paths）；不接受 reset/clean。
 * 渲染层 push/pull/discard 另做恒确认（对等审批卡）；fetch 免确认。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import type { StoredRoot } from "../roots";
import { opErr, opOk } from "./result";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const GIT_NET_TIMEOUT_MS = 60_000;

/** 与 server ``GIT_PROTECTED_BRANCHES`` 对齐（桌面镜像，不改 safety_breaker）。 */
export const GIT_PROTECTED_BRANCHES = new Set(["main", "master"]);

type ScmAction =
  | "stage"
  | "unstage"
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "diff"
  | "discard";

function toReason(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

async function hasLocalGit(absPath: string): Promise<boolean> {
  try {
    await fs.access(join(absPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function runGit(
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (e: unknown) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    const code =
      typeof err.code === "number"
        ? err.code
        : typeof err.code === "string" && /^\d+$/.test(err.code)
          ? Number(err.code)
          : 1;
    return {
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? toReason(e)),
      code,
    };
  }
}

function normalizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const p = item.replace(/\\/g, "/").trim();
    if (!p || p.startsWith("-")) continue;
    out.push(p);
  }
  return out;
}

/**
 * discard 路径护栏（与 UI canDiscard 只传仓内相对路径对齐的纵深）：
 * 拒空、``-`` 前缀、``..`` 穿越、绝对路径。合法则返回归一化相对路径。
 */
export function evaluateDiscardPath(raw: string): string | { path: string } {
  const p = raw.replace(/\\/g, "/").trim();
  if (!p) return "discard 路径不能为空";
  if (p.startsWith("-"))
    return "discard 路径不能以 - 开头（禁止伪装成 git 选项）";
  if (isAbsolute(raw.trim()) || isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    return "discard 禁止绝对路径";
  }
  if (p.startsWith("/") || p.startsWith("//")) {
    return "discard 禁止绝对路径";
  }
  const segments = p.split("/");
  if (segments.some((seg) => seg === "..")) {
    return "discard 禁止路径穿越（..）";
  }
  return { path: p };
}

/** 解析 discard paths；任一非法 → 错误文案（不做静默过滤）。 */
export function evaluateDiscardPaths(
  raw: unknown,
): { paths: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      error:
        "discard 必须指定 paths（禁止无路径整仓丢弃；未跟踪文件不支持 discard）",
    };
  }
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return { error: "discard paths 须为字符串数组" };
    }
    const checked = evaluateDiscardPath(item);
    if (typeof checked === "string") return { error: checked };
    paths.push(checked.path);
  }
  if (paths.length === 0) {
    return {
      error:
        "discard 必须指定 paths（禁止无路径整仓丢弃；未跟踪文件不支持 discard）",
    };
  }
  return { paths };
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout, code } = await runGit(cwd, ["branch", "--show-current"]);
  if (code !== 0) return "";
  return stdout.trim();
}

function failureDetail(
  stdout: string,
  stderr: string,
  fallback: string,
): string {
  const detail = (stderr || stdout || fallback).trim();
  return detail || fallback;
}

function looksLikeConflict(stdout: string, stderr: string): boolean {
  const lower = `${stdout}\n${stderr}`.toLowerCase();
  return (
    lower.includes("conflict") ||
    lower.includes("merge conflict") ||
    lower.includes("fix conflicts") ||
    lower.includes("could not apply")
  );
}

/**
 * 解析 action；非法 → 错误信封。
 */
export function parseGitScmAction(raw: unknown): ScmAction | null {
  const a = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (
    a === "stage" ||
    a === "unstage" ||
    a === "commit" ||
    a === "push" ||
    a === "pull" ||
    a === "fetch" ||
    a === "diff" ||
    a === "discard"
  ) {
    return a;
  }
  return null;
}

/** 纯函数：push 参数是否触碰 force / 保护目标（单测用）。 */
export function evaluatePushGuard(opts: {
  branch: string;
  remote: string;
  args: Record<string, unknown>;
}): string | null {
  if (
    "force" in opts.args ||
    "force_with_lease" in opts.args ||
    "forceWithLease" in opts.args ||
    "refspec" in opts.args
  ) {
    return "禁止 force push 与自定义 refspec；仅允许将当前功能分支推送到指定 remote";
  }
  if ("branch" in opts.args && String(opts.args.branch || "").trim()) {
    return "push 不接受 branch/refspec 参数：只推送当前分支同名到 remote";
  }
  const remote = opts.remote.trim() || "origin";
  if (remote.startsWith("-") || remote === "-f" || remote.includes("--force")) {
    return "禁止 force push";
  }
  if (GIT_PROTECTED_BRANCHES.has(opts.branch)) {
    return "禁止从 main/master 推送，请先 checkout 到功能分支后再 push";
  }
  return null;
}

export async function opGitScm(
  root: StoredRoot,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  if (!(await hasLocalGit(root.absPath))) {
    return opErr(
      "WorkspaceIOError",
      "当前工作区内没有 Git 仓库（仅识别工作区根下的 .git）",
    );
  }

  const action = parseGitScmAction(args.action);
  if (!action) {
    return opErr(
      "WorkspaceIOError",
      "git_scm action 须为 stage / unstage / commit / push / pull / fetch / diff / discard",
    );
  }

  const cwd = root.absPath;

  try {
    switch (action) {
      case "stage":
        return await doStage(cwd, args);
      case "unstage":
        return await doUnstage(cwd, args);
      case "commit":
        return await doCommit(cwd, args);
      case "push":
        return await doPush(cwd, args);
      case "pull":
        return await doPull(cwd, args);
      case "fetch":
        return await doFetch(cwd, args);
      case "diff":
        return await doDiff(cwd, args);
      case "discard":
        return await doDiscard(cwd, args);
      default:
        return opErr("WorkspaceIOError", `未知 git_scm action：${action}`);
    }
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}

async function doStage(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const paths = normalizePaths(args.paths);
  const argv = paths.length > 0 ? ["add", "--", ...paths] : ["add", "-A"];
  const { stdout, stderr, code } = await runGit(cwd, argv);
  if (code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(stdout, stderr, "git add 失败"),
    );
  }
  return opOk({
    action: "stage",
    paths: paths.length > 0 ? paths : ["."],
    detail: (stdout || stderr).trim(),
  });
}

async function doUnstage(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const paths = normalizePaths(args.paths);
  // 仅 ``restore --staged``（不走 ``reset``，与产品禁 reset/clean 口径一致）。
  const argv =
    paths.length > 0
      ? ["restore", "--staged", "--", ...paths]
      : ["restore", "--staged", "."];
  const result = await runGit(cwd, argv);
  if (result.code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(
        result.stdout,
        result.stderr,
        "git unstage 失败（无提交的仓库可能尚不支持 restore --staged）",
      ),
    );
  }
  return opOk({
    action: "unstage",
    paths: paths.length > 0 ? paths : ["."],
    detail: (result.stdout || result.stderr).trim(),
  });
}

async function doCommit(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) {
    return opErr("WorkspaceIOError", "commit 需要非空 message");
  }
  if (message.startsWith("-")) {
    return opErr(
      "WorkspaceIOError",
      "commit message 不能以 '-' 开头（防止被 git 解析为选项）",
    );
  }
  const { stdout, stderr, code } = await runGit(cwd, ["commit", "-m", message]);
  if (code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(stdout, stderr, "git commit 失败"),
    );
  }
  return opOk({
    action: "commit",
    message,
    detail: (stdout || stderr).trim(),
  });
}

async function doPush(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const remote =
    (typeof args.remote === "string" && args.remote.trim()) || "origin";
  const branch = await currentBranch(cwd);
  if (!branch) {
    return opErr("WorkspaceIOError", "无法确定当前分支，拒绝 push");
  }
  const guard = evaluatePushGuard({ branch, remote, args });
  if (guard) return opErr("WorkspaceIOError", guard);

  const remotes = await runGit(cwd, ["remote"]);
  if (remotes.code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(remotes.stdout, remotes.stderr, "无法列出 remote"),
    );
  }
  const listed = remotes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (listed.length === 0) {
    return opErr(
      "WorkspaceIOError",
      "当前仓库未配置 remote。请先配置 remote，或打开已配置凭据的本地仓库后再 push。",
    );
  }
  if (!listed.includes(remote)) {
    return opErr(
      "WorkspaceIOError",
      `remote '${remote}' 不存在（已配置：${listed.join(", ")}）。`,
    );
  }

  const setUpstream = Boolean(args.set_upstream);
  const argv = ["push"];
  if (setUpstream) argv.push("--set-upstream");
  argv.push(remote, branch);

  const { stdout, stderr, code } = await runGit(cwd, argv, GIT_NET_TIMEOUT_MS);
  if (code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(
        stdout,
        stderr,
        "git push 失败（请检查凭据 / remote；去设置凭据或打开已配置凭据的本地仓）",
      ),
    );
  }
  let action = `已推送 ${branch} → ${remote}`;
  if (setUpstream) action += "（已设置上游）";
  const detail = (stdout || stderr).trim();
  return opOk({
    action: "push",
    remote,
    branch,
    detail: detail ? `${action}\n${detail}` : action,
  });
}

async function doPull(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  // Reject strategy knobs — same as server pull.
  for (const k of [
    "rebase",
    "no_ff",
    "no-ff",
    "ff",
    "strategy",
    "allow_unrelated",
    "allowUnrelated",
  ]) {
    if (k in args) {
      return opErr(
        "WorkspaceIOError",
        "pull 仅支持快进（固定 --ff-only）；禁止 rebase/merge 策略参数。非快进或冲突时请人工处理。",
      );
    }
  }

  const remote =
    (typeof args.remote === "string" && args.remote.trim()) || "origin";
  if (remote.startsWith("-")) {
    return opErr("WorkspaceIOError", "remote 名称非法");
  }

  const remotes = await runGit(cwd, ["remote"]);
  if (remotes.code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(remotes.stdout, remotes.stderr, "无法列出 remote"),
    );
  }
  const listed = remotes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (listed.length === 0) {
    return opErr(
      "WorkspaceIOError",
      "当前仓库未配置 remote。请先配置 remote 后再 pull。",
    );
  }
  if (!listed.includes(remote)) {
    return opErr(
      "WorkspaceIOError",
      `remote '${remote}' 不存在（已配置：${listed.join(", ")}）。`,
    );
  }

  const { stdout, stderr, code } = await runGit(
    cwd,
    ["pull", "--ff-only", remote],
    GIT_NET_TIMEOUT_MS,
  );
  if (code !== 0) {
    const detail = failureDetail(stdout, stderr, "git pull --ff-only 失败");
    const conflict = looksLikeConflict(stdout, stderr);
    return opErr(
      "WorkspaceIOError",
      conflict
        ? `${detail}\n存在冲突或非快进：请打开冲突文件手动解决（不做三方合并 UI）。`
        : detail,
    );
  }
  const detail = (stdout || stderr).trim();
  const summary = `已快进拉取 ${remote}`;
  return opOk({
    action: "pull",
    remote,
    ff_only: true,
    detail: detail ? `${summary}\n${detail}` : summary,
  });
}

/**
 * 只更新远端跟踪引用；禁止 force / prune / tags / all / refspec 旋钮。
 */
async function doFetch(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  for (const k of [
    "force",
    "prune",
    "tags",
    "all",
    "refspec",
    "depth",
    "unshallow",
  ]) {
    if (k in args) {
      return opErr(
        "WorkspaceIOError",
        "fetch 仅支持指定 remote，禁止 force/prune/tags/all/refspec 等参数",
      );
    }
  }

  const remote =
    (typeof args.remote === "string" && args.remote.trim()) || "origin";
  if (remote.startsWith("-")) {
    return opErr("WorkspaceIOError", "remote 名称非法");
  }

  const remotes = await runGit(cwd, ["remote"]);
  if (remotes.code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(remotes.stdout, remotes.stderr, "无法列出 remote"),
    );
  }
  const listed = remotes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (listed.length === 0) {
    return opErr(
      "WorkspaceIOError",
      "当前仓库未配置 remote。请先配置 remote 后再 fetch。",
    );
  }
  if (!listed.includes(remote)) {
    return opErr(
      "WorkspaceIOError",
      `remote '${remote}' 不存在（已配置：${listed.join(", ")}）。`,
    );
  }

  const { stdout, stderr, code } = await runGit(
    cwd,
    ["fetch", remote],
    GIT_NET_TIMEOUT_MS,
  );
  if (code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(
        stdout,
        stderr,
        "git fetch 失败（请检查凭据 / remote；去设置凭据或打开已配置凭据的本地仓）",
      ),
    );
  }
  const detail = (stdout || stderr).trim();
  const summary = `已获取 ${remote}`;
  return opOk({
    action: "fetch",
    remote,
    detail: detail ? `${summary}\n${detail}` : summary,
  });
}

/**
 * 窄口丢弃：仅 ``git restore --worktree -- <paths>``。
 * 必须指定 paths；不做整仓、不做 clean（未跟踪文件请自行处理）。
 * 恢复目标是索引/暂存区内容（不是 HEAD）；路径须通过 evaluateDiscardPaths。
 */
async function doDiscard(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const checked = evaluateDiscardPaths(args.paths);
  if ("error" in checked) {
    return opErr("WorkspaceIOError", checked.error);
  }
  const { paths } = checked;
  const { stdout, stderr, code } = await runGit(cwd, [
    "restore",
    "--worktree",
    "--",
    ...paths,
  ]);
  if (code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(stdout, stderr, "丢弃工作区改动失败"),
    );
  }
  return opOk({
    action: "discard",
    paths,
    detail: (stdout || stderr).trim(),
  });
}

async function doDiff(
  cwd: string,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const path =
    typeof args.path === "string" ? args.path.replace(/\\/g, "/").trim() : "";
  if (!path || path.startsWith("-")) {
    return opErr("WorkspaceIOError", "diff 需要合法 path");
  }
  const staged = Boolean(args.staged);
  const argv = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
  // Untracked: ``git diff`` empty — fall back to showing whole file as added.
  const { stdout, stderr, code } = await runGit(cwd, argv);
  if (code !== 0) {
    return opErr(
      "WorkspaceIOError",
      failureDetail(stdout, stderr, "git diff 失败"),
    );
  }
  let text = stdout;
  if (!text.trim() && !staged) {
    // Untracked / empty diff：诚实展示工作区文件全文为新增行（不做三方）。
    try {
      const content = await fs.readFile(join(cwd, path), "utf8");
      text = content
        .split(/\r?\n/)
        .map((l) => `+${l}`)
        .join("\n");
    } catch {
      text = "";
    }
  }
  return opOk({
    action: "diff",
    path,
    staged,
    text,
    detail: (stderr || "").trim(),
  });
}
