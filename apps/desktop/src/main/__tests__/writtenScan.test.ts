/**
 * 产物写回 · 本地执行腿（`fs/workspace/writtenScan`）。
 *
 * 本机执行以工作区为 cwd 直接写盘，`execute` 信封过去只回 stdout/exit_code —— 脚本产出的
 * 文件对交付物台账完全隐形。这里锁住：真产物在列、旁路区与系统噪音不在列、执行前就存在
 * 且未变动的文件不在列、被强杀的执行不报产物、子路径工作区回的是绑定根相对路径。
 */
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  shell: { trashItem: vi.fn() },
}));

import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { type StoredRoot, executeWorkspaceOp } from "../fs-service";
import {
  scanWrittenFiles,
  writtenScanCutoffMs,
} from "../fs/workspace/writtenScan";

type ExecValue = {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  written_files?: string[];
};

const valOf = (r: WorkspaceOpResult): ExecValue => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value as ExecValue;
};

/** node 在 vitest 下必定可用；python/bash 在 runner 上未必有。 */
const WRITE_ARTIFACTS = `
const fs = require('node:fs');
fs.writeFileSync('report.md', '# 报告');
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/chart.png', 'PNG');
for (const zone of ['index', 'trash', 'baselines']) {
  fs.mkdirSync('AgentCore/' + zone, { recursive: true });
  fs.writeFileSync('AgentCore/' + zone + '/noise.json', '{}');
}
fs.mkdirSync('node_modules', { recursive: true });
fs.writeFileSync('node_modules/dep.js', 'x');
fs.writeFileSync('stale.pyc', '\\u0000');
`;

describe("execute 产物写回 (written_files)", () => {
  let dir: string;
  let root: StoredRoot;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "wscan-")));
    root = { id: "r", name: "r", absPath: dir };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 让文件读起来像「执行前就存在且未变动」。 */
  const backdate = async (abs: string) => {
    const old = new Date(Date.now() - 60_000);
    await utimes(abs, old, old);
  };

  const exec = async (args: Record<string, unknown>) =>
    valOf(
      await executeWorkspaceOp(root, "execute" as never, {
        language: "javascript",
        ...args,
      }),
    );

  it("reports this run's artifacts and skips bypass zones / noise / untouched files", async () => {
    await writeFile(join(dir, "seed.txt"), "untouched", "utf-8");
    await backdate(join(dir, "seed.txt"));

    const r = await exec({ code: WRITE_ARTIFACTS });

    expect(r.success).toBe(true);
    // .png 在 AI 列举里算噪音，但 AI 生成的图表正是交付物 —— 必须报。
    expect(r.written_files).toEqual(["artifacts/chart.png", "report.md"]);
  });

  it("reports an empty list when the run writes nothing", async () => {
    await writeFile(join(dir, "seed.txt"), "untouched", "utf-8");
    await backdate(join(dir, "seed.txt"));

    const r = await exec({
      code: "console.log(require('node:fs').readFileSync('seed.txt','utf-8'))",
    });

    expect(r.success).toBe(true);
    // 只读执行必须报空：读文件不改 mtime，纯计算不该凭空产出交付物。
    expect(r.written_files).toEqual([]);
  });

  it("stays silent about artifacts of a run that was force-stopped", async () => {
    const r = await exec({
      code: "require('node:fs').writeFileSync('half.md','partial'); while (true) {}",
      timeout_seconds: 1,
    });

    expect(r.exit_code).toBe(-1);
    // 与云端 copy-out 同规则：强杀的执行不广告可能只写了一半的产物。
    expect(r.written_files).toBeUndefined();
  });

  it("answers root-relative paths for a subpath-scoped workspace", async () => {
    await mkdir(join(dir, "proj"), { recursive: true });

    const r = await exec({
      code: "require('node:fs').writeFileSync('note.md','x')",
      cwd: "proj",
    });

    expect(r.success).toBe(true);
    // list / grep / index_files 同约定：桌面回绑定根相对，服务端再剥子路径前缀。
    expect(r.written_files).toEqual(["proj/note.md"]);
  });
});

describe("scanWrittenFiles 预算", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "wscan-budget-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stops at the directory budget and flags the truncation", async () => {
    for (let i = 0; i < 12; i++) {
      const sub = join(dir, `d${String(i).padStart(2, "0")}`);
      await mkdir(sub, { recursive: true });
      await writeFile(join(sub, "a.txt"), "x", "utf-8");
    }
    const cutoff = writtenScanCutoffMs() - 60_000; // 全都算「本次写的」

    const full = await scanWrittenFiles(dir, cutoff);
    expect(full.files).toHaveLength(12);
    expect(full.truncated).toBe(false);

    const clipped = await scanWrittenFiles(dir, cutoff, { maxDirs: 4 });
    expect(clipped.truncated).toBe(true);
    // BFS：先看根与最浅的目录，被砍掉的永远是更深的尾巴。
    expect(clipped.files.length).toBeLessThan(12);
  });
});
