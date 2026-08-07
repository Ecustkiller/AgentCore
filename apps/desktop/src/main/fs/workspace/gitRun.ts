/**
 * Agent structured ``git`` — desktop half of ``WorkspaceOp.git_run``.
 *
 * Runs allowlisted argv (without the ``git`` binary name) under the bound root.
 * Aligns with server spawn policy: root-only ``.git`` (no climb),
 * ``GIT_CEILING_DIRECTORIES``, refuse reset/clean / force-like push tokens /
 * git-dir boundary overrides. Returns ``{stdout, stderr, exit_code}`` (success
 * envelope even when exit_code ≠ 0 — tool layer interprets). Policy hard-errors
 * become ``ok:false`` envelopes.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import type { StoredRoot } from "../roots";
import { opErr, opOk } from "./result";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const FORCE_TOKENS = new Set(["-f", "--force", "--force-with-lease"]);
const FORBIDDEN_SUBS = new Set(["reset", "clean"]);

function toReason(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

/** Pure: reject dangerous argv before spawn (server policy mirror). */
export function evaluateGitRunArgv(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0) {
    return "git_run 需要非空 argv（不含 git 二进制名的参数列表）";
  }
  const parts: string[] = [];
  for (const item of argv) {
    if (typeof item !== "string") {
      return "git_run argv 须为字符串数组";
    }
    parts.push(item);
  }
  const sub = (parts[0] ?? "").trim().toLowerCase();
  if (!sub) return "git_run argv[0] 不能为空";
  if (FORBIDDEN_SUBS.has(sub)) {
    return `禁止 git ${sub}（硬禁清单，不可由权限模式放开）`;
  }
  for (const a of parts) {
    const t = a.trim();
    if (
      t === "--git-dir" ||
      t.startsWith("--git-dir=") ||
      t === "--work-tree" ||
      t.startsWith("--work-tree=") ||
      t === "--exec-path" ||
      t.startsWith("--exec-path=")
    ) {
      return "禁止改写 git 目录边界（--git-dir / --work-tree / --exec-path）";
    }
  }
  if (sub === "push") {
    for (const a of parts.slice(1)) {
      const t = a.trim();
      if (FORCE_TOKENS.has(t) || t.startsWith("--force")) {
        return "禁止 force push（含 --force-with-lease）";
      }
    }
  }
  return null;
}

function resolveTimeoutMs(args: Record<string, unknown>): number {
  const raw = args.timeout_seconds ?? args.timeoutSeconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(raw * 1000)));
  }
  return DEFAULT_TIMEOUT_MS;
}

async function runGit(
  cwd: string,
  argv: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const ceiling = cwd;
  try {
    const { stdout, stderr } = await execFileAsync("git", argv, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CEILING_DIRECTORIES: ceiling,
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
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    if (err.killed || err.signal === "SIGTERM") {
      return {
        stdout: String(err.stdout ?? ""),
        stderr: `git 操作超时（${argv.join(" ")}）`,
        code: 1,
      };
    }
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

export async function opGitRun(
  root: StoredRoot,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const guard = evaluateGitRunArgv(args.argv);
  if (guard) {
    return opErr("WorkspaceIOError", guard);
  }
  const argv = (args.argv as string[]).map((s) => String(s));
  const timeoutMs = resolveTimeoutMs(args);
  const cwd = root.absPath;

  // Defense: only root ``.git`` (no parent climb). Caller/server may soft-succeed
  // no_repo before issuing; still refuse boundary escapes here.
  try {
    await fs.access(join(cwd, ".git"));
  } catch {
    // Still run rev-parse-like probes so server ensure_repo can distinguish
    // missing vs corrupt — but ceiling keeps discovery inside root.
  }

  try {
    const result = await runGit(cwd, argv, timeoutMs);
    return opOk({
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.code,
    });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}
