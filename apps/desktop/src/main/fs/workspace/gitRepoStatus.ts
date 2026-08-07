/**
 * U1/U2：工作区根 Git 摘要（分支 + dirty + staged/unstaged/冲突列表）。
 * 仅识别根下 `.git`（不上溯）；无仓 / git 不可用 → ``{ present: false }``（勿假成功）。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitChangeEntry,
  GitRepoStatusValue,
  WorkspaceOpResult,
} from "@shared/ipc-contract";
import type { StoredRoot } from "../roots";
import { opOk } from "./result";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;

export type { GitRepoStatusValue };

/** Conflict-ish XY codes (unmerged). */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * 还原 git C-style 引号路径（``"a b"`` / ``"\344\270\255.md"``）。
 * 八进制转义按 UTF-8 字节解码；未加引号则原样返回。
 */
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (s.length < 2 || s[0] !== '"') return s;

  const parts: string[] = [];
  const byteBuf: number[] = [];
  const flushBytes = (): void => {
    if (byteBuf.length === 0) return;
    parts.push(Buffer.from(byteBuf).toString("utf8"));
    byteBuf.length = 0;
  };

  let i = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === undefined) break;
    if (c === '"') break;
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === undefined) break;
      if (n >= "0" && n <= "7") {
        let oct = 0;
        let count = 0;
        while (count < 3 && i + 1 < s.length) {
          const d = s[i + 1];
          if (d === undefined || d < "0" || d > "7") break;
          oct = (oct << 3) | (d.charCodeAt(0) - 0x30);
          i++;
          count++;
        }
        byteBuf.push(oct);
        i++;
        continue;
      }
      flushBytes();
      const escaped: Record<string, string> = {
        a: "\x07",
        b: "\b",
        t: "\t",
        n: "\n",
        v: "\v",
        f: "\f",
        r: "\r",
        "\\": "\\",
        '"': '"',
      };
      parts.push(escaped[n] ?? n);
      i += 2;
      continue;
    }
    flushBytes();
    parts.push(c);
    i++;
  }
  flushBytes();
  return parts.join("");
}

/** 从 status 行路径段取出最终路径（rename 取 ``->`` 右侧）并 unquote。 */
function statusPathFromPart(pathPart: string): string {
  const raw = pathPart.includes(" -> ")
    ? (pathPart.split(" -> ").pop() ?? pathPart).trim()
    : pathPart;
  return unquoteGitPath(raw);
}

/**
 * 解析 ``git status -sb``：分支、dirty、ahead/behind、staged/unstaged/conflicted。
 */
export function parseGitStatusSb(stdout: string): {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  staged: GitChangeEntry[];
  unstaged: GitChangeEntry[];
  conflicted: string[];
} {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    return {
      branch: "(无)",
      dirty: false,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      conflicted: [],
    };
  }

  const first = lines[0] ?? "";
  let branch = "(无)";
  let ahead = 0;
  let behind = 0;
  if (first.startsWith("## ")) {
    const rest = first.slice(3).trim();
    const noCommits = /^No commits yet on (.+)$/i.exec(rest);
    if (noCommits?.[1]) {
      branch = noCommits[1].trim() || "(无)";
    } else {
      // ``main...origin/main [ahead 1, behind 2]`` / ``HEAD (no branch)``
      branch = rest.split("...", 1)[0]?.split(/\s/, 1)[0]?.trim() || "(无)";
      const bracket = /\[([^\]]+)\]/.exec(rest);
      if (bracket?.[1]) {
        const body = bracket[1];
        const a = /\bahead\s+(\d+)/i.exec(body);
        const b = /\bbehind\s+(\d+)/i.exec(body);
        if (a?.[1]) ahead = Number(a[1]) || 0;
        if (b?.[1]) behind = Number(b[1]) || 0;
      }
    }
  }

  const staged: GitChangeEntry[] = [];
  const unstaged: GitChangeEntry[] = [];
  const conflicted: string[] = [];
  const conflictSeen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    const pathPart = line.slice(2).trim();
    // rename: ``R  old -> new`` / ``RM old -> new``（两侧均可带 C-quote）
    const path = statusPathFromPart(pathPart);
    if (!path) continue;

    if (CONFLICT_CODES.has(xy) || xy.includes("U")) {
      if (!conflictSeen.has(path)) {
        conflictSeen.add(path);
        conflicted.push(path);
      }
      continue;
    }

    const x = xy[0] ?? " ";
    const y = xy[1] ?? " ";

    if (xy === "??" || xy === "!!") {
      unstaged.push({ path, code: xy });
      continue;
    }

    if (x !== " " && x !== "?") {
      staged.push({ path, code: `${x} ` });
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ path, code: ` ${y}` });
    }
  }

  return {
    branch,
    dirty: lines.length > 1,
    ahead,
    behind,
    staged,
    unstaged,
    conflicted,
  };
}

export async function opGitRepoStatus(
  root: StoredRoot,
): Promise<WorkspaceOpResult> {
  const gitMeta = join(root.absPath, ".git");
  try {
    await fs.access(gitMeta);
  } catch {
    return opOk({ present: false } satisfies GitRepoStatusValue);
  }

  try {
    // quotepath=false：非 ASCII 直接 UTF-8；解析侧仍 unquote 兜底 octal/空格路径
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotepath=false", "status", "-sb"],
      {
        cwd: root.absPath,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
    );
    const parsed = parseGitStatusSb(String(stdout ?? ""));
    return opOk({
      present: true,
      branch: parsed.branch,
      dirty: parsed.dirty,
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged: parsed.staged,
      unstaged: parsed.unstaged,
      conflicted: parsed.conflicted,
    } satisfies GitRepoStatusValue);
  } catch {
    // git 缺失 / 超时 / 非仓 → 诚实隐藏，不挂假分支
    return opOk({ present: false } satisfies GitRepoStatusValue);
  }
}
