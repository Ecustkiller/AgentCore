/**
 * Outbox writebacker: at-least-once drain + idempotent delivery.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    dir: `${base}/outbox-wb-test-${Math.random().toString(36).slice(2)}`,
    bearerPostJson: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => h.dir,
    on: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../auth-client", () => ({
  bearerPostJson: h.bearerPostJson,
  refreshAccessToken: vi.fn(async () => true),
}));

import { drainOutbox, outboxDir } from "../outbox-writeback";

const dir = () => outboxDir();

function writeReady(
  userMessageId: string,
  overrides: Record<string, unknown> = {},
) {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(
    join(dir(), `${userMessageId}.json`),
    JSON.stringify({
      schema_version: 1,
      user_message_id: userMessageId,
      conversation_id: "c1",
      message_id: "m1",
      trace_id: "a".repeat(32),
      user_message: "hello",
      content: "world",
      phase: "ready",
      input_tokens: 1,
      output_tokens: 2,
      reasoning_tokens: 0,
      cache_hit_tokens: 0,
      cache_miss_tokens: 0,
      rounds: 1,
      finish_reason: "stop",
      ...overrides,
    }),
    "utf-8",
  );
}

describe("drainOutbox", () => {
  afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

  beforeEach(() => {
    rmSync(dir(), { recursive: true, force: true });
    h.bearerPostJson.mockReset();
  });

  it("POSTs ready records and deletes on ack (at-least-once)", async () => {
    writeReady("u1");
    h.bearerPostJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        user_message_id: "u1",
        assistant_message_id: "m1",
        title: "T",
      },
    });

    const status = await drainOutbox();
    expect(h.bearerPostJson).toHaveBeenCalledOnce();
    const [path, body] = h.bearerPostJson.mock.calls[0] as [
      string,
      { user_message_id: string; content: string },
    ];
    expect(path).toBe("/v1/conversations/c1/local-turns");
    expect(body.user_message_id).toBe("u1");
    expect(body.content).toBe("world");
    expect(status.pending).toEqual([]);
  });

  it("leaves the file when POST fails (retry later)", async () => {
    writeReady("u2");
    h.bearerPostJson.mockResolvedValueOnce({
      ok: false,
      status: 503,
      body: { error: "busy" },
    });
    const status = await drainOutbox();
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]?.userMessageId).toBe("u2");
  });

  it("skips open records during regular drain (no mid-turn salvage)", async () => {
    writeReady("u3", { phase: "open", content: "partial" });
    const status = await drainOutbox();
    expect(h.bearerPostJson).not.toHaveBeenCalled();
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]?.phase).toBe("open");
  });

  it("includes sorted journal on writeback when runs is missing (crash salvage)", async () => {
    writeReady("u-j", {
      runs: null,
      finish_reason: "cancelled",
      journal: {
        "2": { kind: "run_completed", payload: { id: "r1" }, ts: null },
        "0": { kind: "run_started", payload: { id: "r1" }, ts: "t0" },
      },
    });
    h.bearerPostJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        user_message_id: "u-j",
        assistant_message_id: "m1",
        title: null,
      },
    });

    await drainOutbox();
    expect(h.bearerPostJson).toHaveBeenCalledOnce();
    const body = h.bearerPostJson.mock.calls[0]?.[1] as {
      journal?: unknown[];
      finish_reason?: string;
      runs?: unknown;
    };
    expect(body.runs).toBeNull();
    expect(body.finish_reason).toBe("cancelled");
    expect(body.journal).toEqual([
      { kind: "run_started", payload: { id: "r1" }, ts: "t0" },
      { kind: "run_completed", payload: { id: "r1" }, ts: null },
    ]);
  });

  it("salvageOpen promotes abandoned open rows as cancelled (not error)", async () => {
    const { recoverLocalPersistence } = await import("../outbox-writeback");
    writeReady("u-open", {
      phase: "open",
      content: "partial",
      finish_reason: null,
    });
    h.bearerPostJson.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        user_message_id: "u-open",
        assistant_message_id: "m1",
        title: null,
      },
    });

    await recoverLocalPersistence();
    expect(h.bearerPostJson).toHaveBeenCalledOnce();
    const body = h.bearerPostJson.mock.calls[0]?.[1] as {
      finish_reason?: string;
    };
    expect(body.finish_reason).toBe("cancelled");
  });
});
