import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fs-service imports electron at module load (for IPC wiring it doesn't run
// here). Stub it so the dependency-free executeWorkspaceOp can be imported.
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { type StoredRoot, executeWorkspaceOp } from "../fs-service";

// Discriminated-union accessors that fail loudly on the wrong branch.
const valOf = (r: WorkspaceOpResult): unknown => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const errOf = (r: WorkspaceOpResult) => {
  if (r.ok)
    throw new Error(`expected error, got value ${JSON.stringify(r.value)}`);
  return r.error;
};

describe("executeWorkspaceOp (本地工作区写类 op，P2b)", () => {
  let dir: string;
  let root: StoredRoot;
  // realpath the temp dir: os.tmpdir() is often a symlink (macOS /tmp), and the
  // traversal guard compares against the canonical root.
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "ws-")));
    root = { id: "r", name: "r", absPath: dir };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (op: string, args: Record<string, unknown>) =>
    executeWorkspaceOp(root, op as never, args);

  it("write creates the file with parents and reports the code-point count", async () => {
    // "hi😀" = 3 code points (the emoji is one), matching Python len() — not the
    // 4 UTF-16 units JS .length would give.
    const r = await run("write", { path: "a/b/c.txt", content: "hi😀" });
    expect(valOf(r)).toBe(3);
    expect(await readFile(join(dir, "a/b/c.txt"), "utf-8")).toBe("hi😀");
  });

  it("write overwrites an existing file atomically", async () => {
    await run("write", { path: "f.txt", content: "old" });
    const r = await run("write", { path: "f.txt", content: "fresh" });
    expect(r.ok).toBe(true);
    expect(await readFile(join(dir, "f.txt"), "utf-8")).toBe("fresh");
  });

  it("read_bytes round-trips raw bytes as base64 and reports PathNotFound", async () => {
    const raw = Buffer.from([0, 1, 2, 255]);
    await writeFile(join(dir, "blob"), raw);
    const r = await run("read_bytes", { path: "blob" });
    expect(Buffer.from(valOf(r) as string, "base64")).toEqual(raw);
    expect(errOf(await run("read_bytes", { path: "nope" })).kind).toBe(
      "PathNotFound",
    );
  });

  it("write_bytes decodes base64 and reports the byte count", async () => {
    const raw = Buffer.from([10, 20, 30, 40]);
    const r = await run("write_bytes", {
      path: "out.bin",
      data: raw.toString("base64"),
    });
    expect(valOf(r)).toBe(4);
    expect(await readFile(join(dir, "out.bin"))).toEqual(raw);
  });

  it("mkdir creates nested dirs and refuses an existing path", async () => {
    expect((await run("mkdir", { path: "x/y/z" })).ok).toBe(true);
    expect((await stat(join(dir, "x/y/z"))).isDirectory()).toBe(true);
    expect(errOf(await run("mkdir", { path: "x/y/z" })).kind).toBe(
      "AlreadyExists",
    );
  });

  it("delete removes a file and a directory tree, else PathNotFound", async () => {
    await run("write", { path: "d/f.txt", content: "x" });
    expect((await run("delete", { path: "d/f.txt" })).ok).toBe(true);
    expect((await run("delete", { path: "d" })).ok).toBe(true);
    expect(errOf(await run("delete", { path: "ghost" })).kind).toBe(
      "PathNotFound",
    );
  });

  it("move renames, creates dst parents, and guards clobber / missing src", async () => {
    await run("write", { path: "src.txt", content: "data" });
    expect(
      (await run("move", { src: "src.txt", dst: "nested/dst.txt" })).ok,
    ).toBe(true);
    expect(await readFile(join(dir, "nested/dst.txt"), "utf-8")).toBe("data");
    expect(errOf(await run("read", { path: "src.txt" })).kind).toBe(
      "PathNotFound",
    );

    await run("write", { path: "taken.txt", content: "1" });
    expect(
      errOf(await run("move", { src: "nested/dst.txt", dst: "taken.txt" }))
        .kind,
    ).toBe("AlreadyExists");
    expect(errOf(await run("move", { src: "ghost", dst: "z.txt" })).kind).toBe(
      "PathNotFound",
    );
  });

  it("replace (single) returns count 1 and the 1-based first line", async () => {
    await run("write", { path: "r.txt", content: "a\nbXb\nc" });
    const r = await run("replace", {
      path: "r.txt",
      old: "X",
      new: "Y",
      all: false,
    });
    expect(valOf(r)).toEqual({ count: 1, first_line: 2 });
    expect(await readFile(join(dir, "r.txt"), "utf-8")).toBe("a\nbYb\nc");
  });

  it("replace (all) returns the total count and a null first line", async () => {
    await run("write", { path: "r.txt", content: "x x x" });
    const r = await run("replace", {
      path: "r.txt",
      old: "x",
      new: "y",
      all: true,
    });
    expect(valOf(r)).toEqual({ count: 3, first_line: null });
    expect(await readFile(join(dir, "r.txt"), "utf-8")).toBe("y y y");
  });

  it("replace surfaces AmbiguousMatch with the match count when not all", async () => {
    await run("write", { path: "r.txt", content: "x x" });
    const err = errOf(
      await run("replace", { path: "r.txt", old: "x", new: "y", all: false }),
    );
    expect(err).toEqual({
      kind: "AmbiguousMatch",
      detail: "2 matches",
      count: 2,
    });
  });

  it("replace maps NoMatch / NotUTF8 / NotAFile", async () => {
    await run("write", { path: "r.txt", content: "abc" });
    expect(
      errOf(
        await run("replace", {
          path: "r.txt",
          old: "zzz",
          new: "y",
          all: false,
        }),
      ).kind,
    ).toBe("NoMatch");

    await writeFile(join(dir, "bin"), Buffer.from([0xff, 0xfe, 0x00]));
    expect(
      errOf(
        await run("replace", { path: "bin", old: "x", new: "y", all: false }),
      ).kind,
    ).toBe("NotUTF8");

    await run("mkdir", { path: "adir" });
    expect(
      errOf(
        await run("replace", { path: "adir", old: "x", new: "y", all: false }),
      ).kind,
    ).toBe("NotAFile");
  });

  it("refuses traversal escapes without touching disk", async () => {
    expect(errOf(await run("read", { path: "../escape" })).kind).toBe(
      "OutsideWorkspace",
    );
    expect(
      errOf(await run("write", { path: "../evil.txt", content: "x" })).kind,
    ).toBe("OutsideWorkspace");
  });

  it("rejects a write that escapes through a symlinked ancestor", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ws-out-")));
    let linked = true;
    try {
      // "junction" needs no elevation on Windows; ignored (plain symlink) on POSIX.
      await symlink(outside, join(dir, "link"), "junction");
    } catch {
      linked = false; // environment forbids link creation — skip the assertion
    }
    if (linked) {
      expect(
        errOf(await run("write", { path: "link/evil.txt", content: "x" })).kind,
      ).toBe("OutsideWorkspace");
      await expect(
        readFile(join(outside, "evil.txt"), "utf-8"),
      ).rejects.toThrow();
    }
    await rm(outside, { recursive: true, force: true });
  });

  it("routes read / list through the dispatcher", async () => {
    await run("write", { path: "hello.txt", content: "hi" });
    expect(valOf(await run("read", { path: "hello.txt" }))).toBe("hi");
    const entries = valOf(
      await run("list", { directory: ".", pattern: "*" }),
    ) as {
      path: string;
    }[];
    expect(entries.some((e) => e.path === "hello.txt")).toBe(true);
  });

  it("answers a genuinely unknown op as a typed IO error", async () => {
    const err = errOf(await run("bogus_op", {}));
    expect(err.kind).toBe("WorkspaceIOError");
  });

  // Execution tests drive `node` (guaranteed on PATH under vitest, cross-platform)
  // rather than python/bash, which may be absent on the runner.
  describe("execute (P2c, 本地代码执行)", () => {
    const exec = async (args: Record<string, unknown>) =>
      valOf(await run("execute", { language: "javascript", ...args })) as {
        success: boolean;
        stdout: string;
        stderr: string;
        exit_code: number;
        duration_ms: number;
      };

    it("runs code and captures stdout with a zero exit", async () => {
      const r = await exec({ code: "console.log('hi from node')" });
      expect(r.success).toBe(true);
      expect(r.exit_code).toBe(0);
      expect(r.stdout).toContain("hi from node");
    });

    it("runs in the bound root as its working directory", async () => {
      await run("write", { path: "marker.txt", content: "X" });
      const r = await exec({
        code: "console.log(require('node:fs').readdirSync('.').join(','))",
      });
      expect(r.success).toBe(true);
      expect(r.stdout).toContain("marker.txt");
    });

    it("feeds stdin to the process", async () => {
      const r = await exec({
        code: "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write('got:'+b))",
        stdin: "ping",
      });
      expect(r.stdout).toContain("got:ping");
    });

    it("reports a non-zero exit code as failure", async () => {
      const r = await exec({ code: "process.exit(3)" });
      expect(r.success).toBe(false);
      expect(r.exit_code).toBe(3);
    });

    it("kills a run that exceeds the timeout", async () => {
      const r = await exec({ code: "while (true) {}", timeout_seconds: 1 });
      expect(r.success).toBe(false);
      expect(r.exit_code).toBe(-1);
      expect(r.stderr).toContain("Timeout");
    });

    it("rejects an unsupported language", async () => {
      const r = valOf(
        await run("execute", { language: "ruby", code: "puts 1" }),
      ) as { success: boolean; stderr: string; exit_code: number };
      expect(r.success).toBe(false);
      expect(r.stderr).toContain("Unsupported language");
      expect(r.exit_code).toBe(1);
    });
  });
});
