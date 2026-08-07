/**
 * SidecarManager forwards account userId on initialize + startTurn (not hardcoded "local").
 * @vitest-environment node
 */
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    dir: `${base}/sidecar-userid-test-${Math.random().toString(36).slice(2)}`,
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

function capturingTransport() {
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
        Promise.resolve().then(() => {
          lineCb?.(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result:
                msg.method === "initialize"
                  ? { ok: true }
                  : {
                      turnId: "t1",
                      messageId: "m1",
                      content: "",
                      reasoningContent: null,
                      finishReason: "stop",
                      model: "x",
                      rounds: 1,
                      usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        reasoningTokens: 0,
                        cacheHitTokens: 0,
                        cacheMissTokens: 0,
                      },
                      citations: [],
                      runs: null,
                      error: null,
                    },
            }),
          );
        });
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

describe("SidecarManager userId passthrough", () => {
  afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

  it("initialize + startTurn use account userId when provided", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);
    const wc = { isDestroyed: () => false, send: vi.fn() };

    await manager.startTurn(
      wc as never,
      {
        conversationId: "c1",
        rootId: "r1",
        turnId: "turn-1",
        traceId: "a".repeat(32),
        userId: "acct-uuid-99",
        userMessageId: "u1",
        userMessage: "hello",
      },
      "/tmp/ws",
    );

    const init = t.sent.find((m) => m.method === "initialize");
    const start = t.sent.find((m) => m.method === "startTurn");
    expect(init?.params?.userId).toBe("acct-uuid-99");
    expect(start?.params?.userId).toBe("acct-uuid-99");
  });

  it("initialize falls back to local when userId absent", async () => {
    const t = capturingTransport();
    const manager = new SidecarManager(() => t.transport);
    const wc = { isDestroyed: () => false, send: vi.fn() };

    await manager.startTurn(
      wc as never,
      {
        conversationId: "c2",
        rootId: "r2",
        turnId: "turn-2",
        traceId: "b".repeat(32),
        userMessageId: "u2",
        userMessage: "hello",
      },
      "/tmp/ws",
    );

    const init = t.sent.find((m) => m.method === "initialize");
    const start = t.sent.find((m) => m.method === "startTurn");
    expect(init?.params?.userId).toBe("local");
    expect(start?.params?.userId).toBeUndefined();
  });
});
