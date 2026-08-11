/**
 * SidecarManager.warmAccountRulesMemory + first startTurn kick;
 * no-auth skip does not lock; late login re-warms; ensure/probe do not kick.
 * @vitest-environment node
 */
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    dir: `${base}/sidecar-warm-rules-test-${Math.random().toString(36).slice(2)}`,
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn(), getAppPath: () => "", getPath: () => h.dir },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../log-service", () => ({
  logDesktop: vi.fn(),
}));

import { rmSync } from "node:fs";
import { SidecarManager } from "../sidecar/manager";
import type { Transport } from "../sidecar/transport";

function capturingTransport(opts?: { warmDelayMs?: number }) {
  const sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  let lineCb: ((line: string) => void) | null = null;
  const transport: Transport = {
    send: (line) => {
      const msg = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      sent.push({ method: msg.method, params: msg.params });
      if (typeof msg.id === "number" && msg.method) {
        const delay =
          msg.method === "warmAccountRulesMemory" && opts?.warmDelayMs
            ? opts.warmDelayMs
            : 0;
        const reply = () => {
          lineCb?.(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { ok: true, warmed: true },
            }),
          );
        };
        if (delay > 0) {
          setTimeout(reply, delay);
        } else {
          Promise.resolve().then(reply);
        }
      }
    },
    onLine: (cb) => {
      lineCb = cb;
    },
    onClose: () => {},
    close: vi.fn(),
  };
  return { transport, sent };
}

const accountAuth = {
  baseUrl: "https://api.example.com/v1/account",
  apiKey: "acct-tok",
};

function startTurnReq(
  overrides: Partial<{
    conversationId: string;
    rootId: string;
    turnId: string;
    userMessageId: string;
    folderId: string | null;
    accountAuth: typeof accountAuth;
    userId: string;
  }> = {},
) {
  return {
    conversationId: overrides.conversationId ?? "c1",
    rootId: overrides.rootId ?? "r1",
    turnId: overrides.turnId ?? "turn-1",
    traceId: "a".repeat(32),
    userMessageId: overrides.userMessageId ?? "u1",
    userMessage: "hello",
    folderId: overrides.folderId ?? "folder-1",
    accountAuth: overrides.accountAuth,
    userId: overrides.userId,
  };
}

describe("SidecarManager warmAccountRulesMemory", () => {
  afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

  it("warmAccountRulesMemory sends RPC with accountAuth + folderId after initialize", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);

    await manager.warmAccountRulesMemory("r1", "", "/tmp/ws-warm-rules", {
      folderId: "folder-1",
      accountAuth,
      userId: "user-1",
    });

    expect(t.sent.map((m) => m.method)).toEqual([
      "initialize",
      "warmAccountRulesMemory",
    ]);
    const init = t.sent.find((m) => m.method === "initialize");
    expect(init?.params?.userId).toBe("user-1");
    const warm = t.sent.find((m) => m.method === "warmAccountRulesMemory");
    expect(warm?.params).toEqual({
      folderId: "folder-1",
      accountAuth,
      userId: "user-1",
    });
  });

  it("skips RPC when accountAuth absent", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);

    await manager.warmAccountRulesMemory("r1", "", "/tmp/ws-warm-rules-skip", {
      folderId: "folder-1",
    });

    expect(t.sent.map((m) => m.method)).toEqual(["initialize"]);
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(0);
  });

  it("ensure / probe cache hit does not kick warmAccountRulesMemory", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);

    await manager.probe("r1", "", "/tmp/ws-warm-rules2");
    expect(t.sent.filter((m) => m.method === "initialize").length).toBe(1);
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(0);

    await manager.probe("r1", "", "/tmp/ws-warm-rules2");
    expect(t.sent.filter((m) => m.method === "initialize").length).toBe(1);
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(0);
  });

  it("first startTurn with accountAuth awaits warm once before startTurn RPC", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);
    const wc = { isDestroyed: () => false, send: vi.fn() };

    await manager.startTurn(
      wc as never,
      startTurnReq({
        rootId: "r-st",
        turnId: "turn-st-1",
        accountAuth,
        userId: "user-st",
      }),
      "/tmp/ws-st",
    );

    expect(t.sent.map((m) => m.method)).toEqual([
      "initialize",
      "warmAccountRulesMemory",
      "startTurn",
    ]);
    const warm = t.sent.find((m) => m.method === "warmAccountRulesMemory");
    expect(warm?.params).toEqual({
      folderId: "folder-1",
      accountAuth,
      userId: "user-st",
    });

    await manager.startTurn(
      wc as never,
      startTurnReq({
        rootId: "r-st",
        turnId: "turn-st-2",
        userMessageId: "u2",
        accountAuth,
        userId: "user-st",
      }),
      "/tmp/ws-st",
    );

    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(1);
    expect(t.sent.filter((m) => m.method === "initialize").length).toBe(1);
    expect(t.sent.filter((m) => m.method === "startTurn").length).toBe(2);
  });

  it("no-auth skip does not lock; late login with auth re-warms", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);
    const wc = { isDestroyed: () => false, send: vi.fn() };

    await manager.startTurn(
      wc as never,
      startTurnReq({ rootId: "r-noauth", turnId: "t1" }),
      "/tmp/ws-noauth",
    );
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(0);

    await manager.startTurn(
      wc as never,
      startTurnReq({
        rootId: "r-noauth",
        turnId: "t2",
        userMessageId: "u2",
        accountAuth,
        userId: "user-late",
      }),
      "/tmp/ws-noauth",
    );
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(1);
    const warm = t.sent.find((m) => m.method === "warmAccountRulesMemory");
    expect(warm?.params?.userId).toBe("user-late");
  });

  it("explicit warm marks entry so subsequent startTurn does not re-kick", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);

    await manager.warmAccountRulesMemory("r-open", "", "/tmp/ws-open", {
      folderId: "folder-1",
      accountAuth,
      userId: "user-open",
    });
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(1);

    await manager.startTurn(
      { isDestroyed: () => false, send: vi.fn() } as never,
      startTurnReq({
        rootId: "r-open",
        turnId: "turn-after-open",
        accountAuth,
        userId: "user-open",
      }),
      "/tmp/ws-open",
    );
    expect(
      t.sent.filter((m) => m.method === "warmAccountRulesMemory").length,
    ).toBe(1);
  });

  it("startTurn awaits in-flight account warm before startTurn RPC", async () => {
    const t = capturingTransport({ warmDelayMs: 40 });
    const manager = new SidecarManager(() => t.transport);
    const wc = { isDestroyed: () => false, send: vi.fn() };

    const warmP = manager.warmAccountRulesMemory(
      "r-await-rules",
      "",
      "/tmp/ws-await-rules",
      { folderId: "folder-1", accountAuth, userId: "user-await" },
    );
    await vi.waitFor(() => {
      expect(t.sent.some((m) => m.method === "warmAccountRulesMemory")).toBe(
        true,
      );
    });
    expect(t.sent.some((m) => m.method === "startTurn")).toBe(false);

    const turnP = manager.startTurn(
      wc as never,
      startTurnReq({
        rootId: "r-await-rules",
        turnId: "turn-await-rules",
        accountAuth,
        userId: "user-await",
      }),
      "/tmp/ws-await-rules",
    );

    await Promise.all([warmP, turnP]);
    const methods = t.sent.map((m) => m.method);
    const warmIdx = methods.indexOf("warmAccountRulesMemory");
    const turnIdx = methods.indexOf("startTurn");
    expect(warmIdx).toBeGreaterThanOrEqual(0);
    expect(turnIdx).toBeGreaterThan(warmIdx);
  });
});
