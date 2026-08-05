// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitRepoStatus, gitTrackHasWork } from "../gitRepoStatus";
import {
  GIT_DISCARD_CONFIRM,
  GIT_PUSH_CONFIRM,
  gitDiscardConfirmMessage,
  gitPush,
} from "../gitScm";

vi.mock("@/lib/toast", () => ({
  notifyActionError: vi.fn(),
  notifySuccess: vi.fn(),
}));

describe("fetchGitRepoStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when fsApi missing", async () => {
    vi.stubGlobal("window", {});
    expect(await fetchGitRepoStatus("r1")).toBeNull();
  });

  it("normalizes optional U2 fields", async () => {
    vi.stubGlobal("window", {
      fsApi: {
        workspaceOp: vi.fn(async () => ({
          ok: true as const,
          value: {
            present: true,
            branch: "main",
            dirty: true,
            ahead: 1,
            staged: [{ path: "a.ts", code: "M " }],
            unstaged: [],
            conflicted: [],
          },
        })),
      },
    });
    expect(await fetchGitRepoStatus("r1")).toEqual({
      present: true,
      branch: "main",
      dirty: true,
      ahead: 1,
      behind: 0,
      staged: [{ path: "a.ts", code: "M " }],
      unstaged: [],
      conflicted: [],
    });
  });

  it("returns null when present:false (no repo)", async () => {
    vi.stubGlobal("window", {
      fsApi: {
        workspaceOp: vi.fn(async () => ({
          ok: true as const,
          value: { present: false },
        })),
      },
    });
    expect(await fetchGitRepoStatus("r1")).toBeNull();
  });

  it("returns null on op error", async () => {
    vi.stubGlobal("window", {
      fsApi: {
        workspaceOp: vi.fn(async () => ({
          ok: false as const,
          error: { kind: "WorkspaceIOError", detail: "x" },
        })),
      },
    });
    expect(await fetchGitRepoStatus("r1")).toBeNull();
  });
});

describe("gitTrackHasWork", () => {
  it("true when dirty / ahead / conflict", () => {
    expect(
      gitTrackHasWork({
        present: true,
        branch: "f",
        dirty: true,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [{ path: "a", code: "??" }],
        conflicted: [],
      }),
    ).toBe(true);
    expect(
      gitTrackHasWork({
        present: true,
        branch: "f",
        dirty: false,
        ahead: 1,
        behind: 0,
        staged: [],
        unstaged: [],
        conflicted: [],
      }),
    ).toBe(true);
    expect(
      gitTrackHasWork({
        present: true,
        branch: "f",
        dirty: false,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        conflicted: ["c.ts"],
      }),
    ).toBe(true);
  });

  it("false when clean and synced", () => {
    expect(
      gitTrackHasWork({
        present: true,
        branch: "f",
        dirty: false,
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        conflicted: [],
      }),
    ).toBe(false);
    expect(gitTrackHasWork(null)).toBe(false);
  });
});

describe("gitPush confirm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts without calling op when user cancels confirm", async () => {
    const workspaceOp = vi.fn();
    vi.stubGlobal("window", {
      confirm: () => false,
      fsApi: { workspaceOp },
    });
    expect(await gitPush("r1")).toBe(false);
    expect(workspaceOp).not.toHaveBeenCalled();
  });

  it("calls git_scm push after confirm", async () => {
    const workspaceOp = vi.fn(async () => ({
      ok: true as const,
      value: { action: "push", detail: "已推送 feature → origin" },
    }));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", {
      confirm,
      fsApi: { workspaceOp },
    });
    expect(await gitPush("r1")).toBe(true);
    expect(confirm).toHaveBeenCalledWith(GIT_PUSH_CONFIRM);
    expect(workspaceOp).toHaveBeenCalledWith(
      "r1",
      "git_scm",
      expect.objectContaining({ action: "push" }),
    );
  });
});

describe("gitDiscard confirm copy", () => {
  it("honestly describes restore --worktree (index, not HEAD)", () => {
    expect(GIT_DISCARD_CONFIRM).toMatch(/暂存区|索引/);
    expect(GIT_DISCARD_CONFIRM).not.toMatch(/\bHEAD\b/);
    expect(GIT_DISCARD_CONFIRM).toMatch(/不是上次提交/);
    expect(gitDiscardConfirmMessage(1)).toBe(GIT_DISCARD_CONFIRM);
    const multi = gitDiscardConfirmMessage(3);
    expect(multi).toMatch(/3 个文件/);
    expect(multi).toMatch(/暂存区|索引/);
    expect(multi).not.toMatch(/\bHEAD\b/);
  });
});
