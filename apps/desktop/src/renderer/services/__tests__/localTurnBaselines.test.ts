import { listLocalTurnBaselineIds } from "@/services/localTurnBaselines";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

describe("listLocalTurnBaselineIds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps AgentCore/baselines/*.zip stems to message ids", async () => {
    const listDir = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          name: "turn-a.zip",
          relPath: "AgentCore/baselines/turn-a.zip",
          kind: "file",
          size: 10,
          modifiedMs: 1,
        },
        {
          name: "notes.txt",
          relPath: "AgentCore/baselines/notes.txt",
          kind: "file",
          size: 1,
          modifiedMs: 1,
        },
        {
          name: "nested",
          relPath: "AgentCore/baselines/nested",
          kind: "dir",
          size: null,
          modifiedMs: 1,
        },
      ],
    });
    vi.stubGlobal("window", { fsApi: { listDir } });

    await expect(listLocalTurnBaselineIds("root-1", "")).resolves.toEqual([
      "turn-a",
    ]);
    expect(listDir).toHaveBeenCalledWith("root-1", "AgentCore/baselines");
  });

  it("prefixes conversation subpath when listing", async () => {
    const listDir = vi.fn().mockResolvedValue({ ok: true, data: [] });
    vi.stubGlobal("window", { fsApi: { listDir } });

    await listLocalTurnBaselineIds("root-1", "conversations/c1");
    expect(listDir).toHaveBeenCalledWith(
      "root-1",
      "conversations/c1/AgentCore/baselines",
    );
  });

  it("returns [] when listDir fails or fsApi missing", async () => {
    vi.stubGlobal("window", {});
    await expect(listLocalTurnBaselineIds("r")).resolves.toEqual([]);

    vi.stubGlobal("window", {
      fsApi: {
        listDir: vi.fn().mockResolvedValue({
          ok: false,
          reason: "missing",
          code: "not_found",
        }),
      },
    });
    await expect(listLocalTurnBaselineIds("r")).resolves.toEqual([]);
  });
});
