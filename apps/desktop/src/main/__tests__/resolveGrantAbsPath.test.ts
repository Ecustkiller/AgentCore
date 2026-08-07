/**
 * @vitest-environment node
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGrantAbsPath } from "../fs/resolveGrantAbsPath";

describe("resolveGrantAbsPath", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  async function makeTemp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "grant-resolve-"));
    temps.push(dir);
    return dir;
  }

  it("resolves absolute path to a directory", async () => {
    const root = await makeTemp();
    const target = join(root, "咨询");
    await mkdir(target);

    const result = await resolveGrantAbsPath({
      path: target,
      resolveWellKnown: async () => {
        throw new Error("should not call wellKnown");
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displayLabel).toBe("咨询");
    expect(result.absPath.replace(/\\/g, "/")).toContain("咨询");
  });

  it("returns not_found when absolute path does not exist", async () => {
    const root = await makeTemp();
    const result = await resolveGrantAbsPath({
      path: join(root, "no-such-dir"),
      resolveWellKnown: async () => root,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_directory when path hits a file", async () => {
    const root = await makeTemp();
    const file = join(root, "notes.txt");
    await writeFile(file, "x");

    const result = await resolveGrantAbsPath({
      path: file,
      resolveWellKnown: async () => root,
    });
    expect(result).toEqual({ ok: false, reason: "not_directory" });
  });

  it("returns not_found with neither path nor wellKnown (no picker)", async () => {
    const result = await resolveGrantAbsPath({
      resolveWellKnown: async () => {
        throw new Error("unused");
      },
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves wellKnown + targetName to a child directory", async () => {
    const desktop = await makeTemp();
    await mkdir(join(desktop, "咨询"));

    const result = await resolveGrantAbsPath({
      wellKnown: "desktop",
      targetName: "咨询",
      resolveWellKnown: async () => desktop,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displayLabel).toBe("桌面 › 咨询");
  });

  it("returns not_found when wellKnown child is missing", async () => {
    const desktop = await makeTemp();
    const result = await resolveGrantAbsPath({
      wellKnown: "desktop",
      targetName: "不存在的包",
      resolveWellKnown: async () => desktop,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_directory when wellKnown child is a file", async () => {
    const desktop = await makeTemp();
    await writeFile(join(desktop, "notes.txt"), "x");

    const result = await resolveGrantAbsPath({
      wellKnown: "desktop",
      targetName: "notes",
      resolveWellKnown: async () => desktop,
    });
    expect(result).toEqual({ ok: false, reason: "not_directory" });
  });

  it("returns ambiguous when multiple child dirs match", async () => {
    const desktop = await makeTemp();
    await mkdir(join(desktop, "June Reports"));
    await mkdir(join(desktop, "July Reports"));

    const result = await resolveGrantAbsPath({
      wellKnown: "desktop",
      targetName: "Reports",
      resolveWellKnown: async () => desktop,
    });
    expect(result).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("prefers path over wellKnown when both given", async () => {
    const desktop = await makeTemp();
    const other = await makeTemp();
    await mkdir(join(other, "优先"));

    const result = await resolveGrantAbsPath({
      path: join(other, "优先"),
      wellKnown: "desktop",
      targetName: "优先",
      resolveWellKnown: async () => desktop,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displayLabel).toBe("优先");
    expect(result.absPath.replace(/\\/g, "/")).toContain("优先");
  });
});
