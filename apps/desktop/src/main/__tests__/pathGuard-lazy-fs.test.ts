import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
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
}));

import {
  __clearRealRootCacheForTests,
  isWindowsReservedDeviceSegment,
  locate,
  pathHasWindowsReservedDeviceName,
  realInside,
  resolveLexical,
} from "../fs/pathGuard";
import { type StoredRoot, setRoot } from "../fs/roots";
import { create, listDir } from "../fs/tree";

describe("pathGuard realInside / locate error codes", () => {
  let dir: string;
  let root: StoredRoot;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "pg-")));
    root = { id: "pg-root", name: "pg", absPath: dir };
    setRoot(root);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("realInside returns not_found for missing path", async () => {
    const abs = join(dir, "no-such-dir");
    const r = await realInside(root, abs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.reason).toContain("不存在");
  });

  it("realInside returns path for existing entry", async () => {
    await writeFile(join(dir, "f.txt"), "x");
    const r = await realInside(root, join(dir, "f.txt"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(await realpath(join(dir, "f.txt")));
  });

  it("locate marks lexical escape as out_of_root", () => {
    const r = locate(root.id, "../outside");
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toEqual({
      ok: false,
      code: "out_of_root",
      reason: "路径越界，已拒绝",
    });
  });

  it("locate marks unknown root as unauthorized", () => {
    const r = locate("missing-root", "");
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    if (r.error.ok) return;
    expect(r.error.code).toBe("unauthorized");
  });

  it("resolveLexical keeps in-root paths", () => {
    expect(resolveLexical(root, "a/b")).toBe(join(dir, "a", "b"));
  });

  it("resolveLexical maps bare / and \\ to workspace root", () => {
    expect(resolveLexical(root, "/")).toBe(dir);
    expect(resolveLexical(root, "\\")).toBe(dir);
  });

  it("resolveLexical strips /<root.name>/… and rejects /etc", () => {
    root = { id: "pg-root", name: "workspace", absPath: dir };
    setRoot(root);
    expect(resolveLexical(root, "/workspace/a.txt")).toBe(join(dir, "a.txt"));
    expect(resolveLexical(root, "/etc/passwd")).toBeNull();
  });

  it("rejects Windows reserved device names before touching disk", () => {
    expect(pathHasWindowsReservedDeviceName("nul")).toBe(true);
    expect(pathHasWindowsReservedDeviceName("subdir/CON")).toBe(true);
    expect(isWindowsReservedDeviceSegment("nul.txt")).toBe(true);
    expect(isWindowsReservedDeviceSegment("null.txt")).toBe(false);

    expect(resolveLexical(root, "nul")).toBeNull();
    expect(resolveLexical(root, "NUL")).toBeNull();
    expect(resolveLexical(root, "con")).toBeNull();
    expect(resolveLexical(root, "PRN")).toBeNull();
    expect(resolveLexical(root, "aux")).toBeNull();
    expect(resolveLexical(root, "COM1")).toBeNull();
    expect(resolveLexical(root, "lpt9")).toBeNull();
    // bare device + extension form (Win32 treats both as devices)
    expect(resolveLexical(root, "nul.txt")).toBeNull();
    expect(resolveLexical(root, "subdir/Con.log")).toBeNull();
    // ordinary lookalikes must pass
    expect(resolveLexical(root, "null.txt")).toBe(join(dir, "null.txt"));
    expect(resolveLexical(root, "console")).toBe(join(dir, "console"));
    expect(resolveLexical(root, "com10")).toBe(join(dir, "com10"));
  });

  it("locate marks reserved device names as invalid (not out_of_root)", () => {
    const r = locate(root.id, "nul");
    expect("error" in r).toBe(true);
    if (!("error" in r) || r.error.ok) return;
    expect(r.error.code).toBe("invalid");
    expect(r.error.reason).toContain("保留设备名");
  });
});

describe("realInside canonical 化根（符号链接祖先不得误判越界）", () => {
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "pg-canon-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function reg(root: StoredRoot): StoredRoot {
    setRoot(root);
    return root;
  }

  it("接受「根本身是符号链接」的合法路径（修复前判 out_of_root）", async () => {
    const target = join(base, "real-ws");
    const linkPath = join(base, "link-ws");
    await mkdir(target);
    await symlink(target, linkPath, "junction");
    await writeFile(join(target, "f.txt"), "x");

    const root = reg({ id: "canon-link", name: "link", absPath: linkPath });
    const r = await realInside(root, join(linkPath, "f.txt"));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 返回的是 canonical 路径（根与目标同坐标系）
    expect(r.path).toBe(await realpath(join(linkPath, "f.txt")));
    expect(r.path).toBe(join(target, "f.txt"));
  });

  it("接受「根的祖先含符号链接」的合法路径（os.tmpdir() 形态）", async () => {
    // 不 realpath：正是 macOS /var → /private/var 的形状，也是
    // stageAttachment.test.ts 的根注册方式。
    const raw = await mkdtemp(join(tmpdir(), "pg-raw-"));
    try {
      await writeFile(join(raw, "notes.md"), "x");
      const root = reg({ id: "canon-raw", name: "raw", absPath: raw });
      const r = await realInside(root, join(raw, "notes.md"));
      expect(r.ok).toBe(true);
    } finally {
      await rm(raw, { recursive: true, force: true });
    }
  });

  it("仍拒绝根内符号链接指向根外的逃逸（不因修根而放宽）", async () => {
    const ws = join(base, "ws");
    const outside = join(base, "outside");
    await mkdir(ws);
    await mkdir(outside);
    await writeFile(join(outside, "s.txt"), "x");
    await symlink(outside, join(ws, "leak"), "junction");

    // 根故意用非 canonical 值：修复后新放行的配置里也必须继续拦住逃逸。
    const root = reg({ id: "canon-esc", name: "esc", absPath: ws });
    const r = await realInside(root, join(ws, "leak", "s.txt"));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("out_of_root");
  });

  it("根不存在时维持 not_found（不新造 error 码）", async () => {
    const ghost = join(base, "ghost-ws");
    const root = reg({ id: "canon-ghost", name: "g", absPath: ghost });
    const r = await realInside(root, join(ghost, "x.txt"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  // 缓存的唯一风险是「根的指向被改掉后读到旧值」。断言它只往安全侧偏——
  // 即拒绝，而不是放行到用户从未授权过的新目标。
  it("根指向被改掉后缓存过期 → fail-closed（拒绝而非放行）", async () => {
    const wsA = join(base, "real-a");
    const wsB = join(base, "real-b");
    const linkPath = join(base, "swap-link");
    await mkdir(wsA);
    await mkdir(wsB);
    await writeFile(join(wsA, "f.txt"), "a");
    await writeFile(join(wsB, "f.txt"), "b");
    await symlink(wsA, linkPath, "junction");

    const root = reg({ id: "canon-swap", name: "swap", absPath: linkPath });

    // 1) 先访问一次，把 canonicalRoot(linkPath) = wsA 写进缓存
    const first = await realInside(root, join(linkPath, "f.txt"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.path).toBe(join(wsA, "f.txt"));

    // 2) 把链接改指向 wsB —— 用户并没有授权过这个新目标
    await rm(linkPath, { force: true });
    await symlink(wsB, linkPath, "junction");

    // 3) 缓存里还是 wsA，realpath 出的是 wsB → 以 .. 开头 → 拒绝
    const after = await realInside(root, join(linkPath, "f.txt"));
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.code).toBe("out_of_root");

    // 4) 显式清缓存后重新评估，新指向才被承认（操作口子存在，且只在这里生效）
    __clearRealRootCacheForTests();
    const cleared = await realInside(root, join(linkPath, "f.txt"));
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.path).toBe(join(wsB, "f.txt"));
  });
});

describe("listDir / create lazy workspace semantics", () => {
  let dir: string;
  let root: StoredRoot;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "fs-lazy-")));
    root = { id: "lazy-root", name: "lazy", absPath: dir };
    setRoot(root);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("listDir returns not_found when subpath is missing", async () => {
    const r = await listDir(root.id, "conv-title");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  it("create materializes missing parents then writes the file", async () => {
    const r = await create(root.id, "conv-title/notes.md", "file");
    expect(r.ok).toBe(true);
    const listed = await listDir(root.id, "conv-title");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.map((e) => e.name)).toContain("notes.md");
  });

  it("create materializes a missing directory workspace", async () => {
    const r = await create(root.id, "fresh-ws/sub", "dir");
    expect(r.ok).toBe(true);
    const listed = await listDir(root.id, "fresh-ws");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.some((e) => e.name === "sub" && e.kind === "dir")).toBe(
      true,
    );
  });
});
