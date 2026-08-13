/**
 * Agent structured ``git`` — desktop half of ``WorkspaceOp.git_run``.
 *
 * Runs allowlisted argv (without the ``git`` binary name) under the project cwd.
 * With ``args.cwd`` (Local D1a subpath) the cwd is that subdirectory under the
 * bound root — same baseline as file_* / exists(".git"); empty cwd = root is the
 * project (open-folder). Aligns with server spawn policy: root-only ``.git`` (no
 * climb), ``GIT_CEILING_DIRECTORIES``, refuse reset/clean / force-like push tokens /
 * git-dir boundary overrides, and a timeout that kills the whole process tree
 * (server ``_reap_git_process``). Returns ``{stdout, stderr, exit_code}`` (success
 * envelope even when exit_code ≠ 0 — tool layer interprets). Policy hard-errors
 * become ``ok:false`` envelopes.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { killProcessTree, treeSpawnOptions } from "../../proc-tree";
import { realInside, resolveLexical, toReason } from "../pathGuard";
import type { StoredRoot } from "../roots";
import { opErr, opOk } from "./result";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
/** Per-stream capture cap (byte-for-byte the previous ``execFile`` maxBuffer). */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/**
 * After the tree kill, how long to wait for the pipes to close before answering.
 * Well inside the server's ``_GIT_KILL_SLACK`` (5s) so the channel reply is never
 * late, and bounded so a kill that failed cannot hang the op.
 */
const KILL_GRACE_MS = 2_000;
const FORCE_TOKENS = new Set(["-f", "--force", "--force-with-lease"]);
const FORBIDDEN_SUBS = new Set(["reset", "clean"]);

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

/**
 * Resolve git process cwd under the bound root.
 *
 * Empty / ``"."`` → root itself (open-folder). Non-empty → project subpath;
 * create if missing so ``init_baseline`` lands here. Never fall back to the
 * container root when a subpath is set (G1+G2).
 */
export async function resolveGitRunCwd(
  root: StoredRoot,
  cwdArg: unknown,
): Promise<{ ok: true; cwd: string } | { ok: false; detail: string }> {
  const raw = cwdArg == null ? "" : String(cwdArg);
  const sub =
    raw === "." ? "" : raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!sub) {
    return { ok: true, cwd: root.absPath };
  }
  if (
    sub === ".." ||
    sub.startsWith("../") ||
    sub.includes("/../") ||
    sub.endsWith("/..")
  ) {
    return { ok: false, detail: `git_run cwd 越界：${sub}` };
  }
  const lexical = resolveLexical(root, sub);
  if (!lexical) {
    return { ok: false, detail: `git_run cwd 越界：${sub}` };
  }
  const existing = await realInside(root, lexical);
  if (existing.ok) {
    return { ok: true, cwd: existing.path };
  }
  if (existing.code !== "not_found") {
    return { ok: false, detail: existing.reason };
  }
  try {
    await fs.mkdir(lexical, { recursive: true });
  } catch (e) {
    return { ok: false, detail: toReason(e) };
  }
  const after = await realInside(root, lexical);
  if (after.ok) return { ok: true, cwd: after.path };
  return { ok: false, detail: after.reason };
}

type CaptureSink = { chunks: Buffer[]; bytes: number };

function sinkText(sink: CaptureSink): string {
  return Buffer.concat(sink.chunks).toString("utf8");
}

/**
 * Spawn ``bin argv`` under ``cwd`` and capture its output.
 *
 * Timeout kills the **whole process tree**, not just the direct child: git hands
 * the network leg to ``git-remote-https`` / credential helpers, and an orphaned
 * grandchild keeps ``.git/index.lock`` so every later call times out on the same
 * lock. The stdout received before the kill is still returned — the tool layer
 * gets whatever git managed to produce, with a timeout ``stderr`` and non-zero code.
 *
 * ``bin`` is a parameter only so tests can drive the timeout path with a
 * controllable process tree; the op always passes ``"git"``. Never rejects.
 */
export function runGitCapture(
  bin: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      cwd,
      windowsHide: true,
      // stdin closed: git never prompts (GIT_TERMINAL_PROMPT=0), and a command that
      // does read stdin should see EOF rather than block until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CEILING_DIRECTORIES: cwd,
      },
      ...treeSpawnOptions(),
    });

    const stdout: CaptureSink = { chunks: [], bytes: 0 };
    const stderr: CaptureSink = { chunks: [], bytes: 0 };
    let timedOut = false;
    let overflow = false;
    let spawnError: Error | null = null;
    let exitCode = 0;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const out = sinkText(stdout);
      if (timedOut) {
        resolve({
          stdout: out,
          stderr: `git 操作超时（${argv.join(" ")}）`,
          code: 1,
        });
        return;
      }
      const err = sinkText(stderr);
      if (overflow) {
        resolve({
          stdout: out,
          stderr:
            err ||
            `git 输出超过 ${MAX_OUTPUT_BYTES / (1024 * 1024)}MB 上限（${argv.join(" ")}）`,
          code: 1,
        });
        return;
      }
      if (spawnError) {
        resolve({ stdout: out, stderr: err || spawnError.message, code: 1 });
        return;
      }
      resolve({ stdout: out, stderr: err, code: exitCode });
    };

    const push = (sink: CaptureSink, chunk: Buffer): void => {
      const room = MAX_OUTPUT_BYTES - sink.bytes;
      if (chunk.length <= room) {
        sink.chunks.push(chunk);
        sink.bytes += chunk.length;
        return;
      }
      if (room > 0) {
        sink.chunks.push(chunk.subarray(0, room));
        sink.bytes += room;
      }
      if (!overflow) {
        overflow = true;
        void killProcessTree(child);
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void killProcessTree(child);
      // Answer on ``close`` if the tree dies promptly, on the grace timer if not.
      graceTimer = setTimeout(finish, KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => push(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => push(stderr, chunk));
    // A killed tree can tear the pipes down mid-read; that is not an op failure.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (e: Error) => {
      spawnError = e;
      finish();
    });
    child.on("close", (code, signal) => {
      exitCode = code ?? (signal ? 1 : 0);
      finish();
    });
  });
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
  const resolved = await resolveGitRunCwd(root, args.cwd);
  if (!resolved.ok) {
    return opErr("OutsideWorkspace", resolved.detail);
  }
  const cwd = resolved.cwd;

  // Defense: only cwd ``.git`` (no parent climb). Caller/server may soft-succeed
  // no_repo before issuing; still refuse boundary escapes here.
  try {
    await fs.access(join(cwd, ".git"));
  } catch {
    // Still run the command so the server can attribute the real git failure
    // (missing vs corrupt) — but ceiling keeps discovery inside cwd.
  }

  try {
    const result = await runGitCapture("git", argv, cwd, timeoutMs);
    return opOk({
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.code,
    });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}
