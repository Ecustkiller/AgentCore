import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    appDataDir: `${base}/agenttown-test-${Math.random().toString(36).slice(2)}`,
    exeDir: `${base}/agenttown-exe-${Math.random().toString(36).slice(2)}`,
    cookies: [] as Array<{ name: string; value: string }>,
    isPackaged: false,
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) =>
      name === "appData" ? h.appDataDir : join(h.appDataDir, "user"),
    isPackaged: () => h.isPackaged,
  },
  session: {
    defaultSession: {
      cookies: {
        get: async () => h.cookies,
      },
    },
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, Array<() => void>> = {};
    return {
      on: (event: string, cb: () => void) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(cb);
        if (event === "spawn") cb();
      },
      unref: vi.fn(),
    };
  }),
}));

import { readFileSync } from "node:fs";
import {
  clearSessionFile,
  resolveAgentTownExe,
  writeSessionFile,
} from "../agenttown-service";

const sessionPath = join(h.appDataDir, "AgentCore", "session.json");

describe("agenttown session file", () => {
  beforeEach(() => {
    rmSync(h.appDataDir, { recursive: true, force: true });
    h.cookies = [];
  });
  afterAll(() => {
    rmSync(h.appDataDir, { recursive: true, force: true });
    rmSync(h.exeDir, { recursive: true, force: true });
  });

  it("writes session.json with explicit tokens", async () => {
    const result = await writeSessionFile({
      api_base: "http://localhost:8000",
      access_token: "access.jwt.token",
      refresh_token: "refresh-token",
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(parsed.api_base).toBe("http://localhost:8000");
    expect(parsed.access_token).toBe("access.jwt.token");
    expect(parsed.refresh_token).toBe("refresh-token");
  });

  it("reads httpOnly cookies when tokens are omitted", async () => {
    h.cookies = [
      { name: "access_token", value: "from-cookie" },
      { name: "refresh_token", value: "refresh-cookie" },
    ];
    const result = await writeSessionFile({
      api_base: "http://localhost:8000",
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(parsed.access_token).toBe("from-cookie");
    expect(parsed.refresh_token).toBe("refresh-cookie");
  });

  it("clears session.json on logout", async () => {
    await writeSessionFile({
      api_base: "http://localhost:8000",
      access_token: "t",
    });
    await clearSessionFile();
    await expect(
      import("node:fs/promises").then((fs) => fs.readFile(sessionPath)),
    ).rejects.toThrow();
  });
});

describe("resolveAgentTownExe", () => {
  beforeEach(() => {
    rmSync(h.exeDir, { recursive: true, force: true });
    delete process.env.AGENTTOWN_PATH;
    h.isPackaged = false;
  });
  afterAll(() => rmSync(h.exeDir, { recursive: true, force: true }));

  it("prefers AGENTTOWN_PATH when set", async () => {
    mkdirSync(h.exeDir, { recursive: true });
    const exe = join(h.exeDir, "AgentTown.exe");
    writeFileSync(exe, "");
    process.env.AGENTTOWN_PATH = exe;
    await expect(resolveAgentTownExe()).resolves.toBe(exe);
  });
});
