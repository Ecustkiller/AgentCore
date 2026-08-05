import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { TEST_ROOT } = vi.hoisted(() => {
  const tmp =
    globalThis.process.env.TMPDIR ??
    globalThis.process.env.TEMP ??
    globalThis.process.env.TMP ??
    "/tmp";
  return {
    TEST_ROOT: `${tmp}/local-store-convid-${globalThis.process.pid}`,
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => TEST_ROOT },
  ipcMain: { handle: vi.fn() },
}));

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOCAL_STORE_CHANNELS,
  type LocalStoreConversationPayload,
} from "@shared/local-store-contract";
import { ipcMain } from "electron";
import { isSafeLocalStoreConvId, registerLocalStoreIpc } from "../local-store";

type Handler = (event: unknown, arg?: unknown) => Promise<unknown>;

function handlerFor(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const found = calls.find((c) => c[0] === channel);
  if (!found) throw new Error(`no handler registered for ${channel}`);
  return found[1] as Handler;
}

registerLocalStoreIpc();

describe("isSafeLocalStoreConvId", () => {
  it("accepts normal UUID and simple ids", () => {
    expect(isSafeLocalStoreConvId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      true,
    );
    expect(isSafeLocalStoreConvId("c0")).toBe(true);
  });

  it("rejects empty, dot segments, separators, NUL", () => {
    expect(isSafeLocalStoreConvId("")).toBe(false);
    expect(isSafeLocalStoreConvId(".")).toBe(false);
    expect(isSafeLocalStoreConvId("..")).toBe(false);
    expect(isSafeLocalStoreConvId("../escape")).toBe(false);
    expect(isSafeLocalStoreConvId("..\\escape")).toBe(false);
    expect(isSafeLocalStoreConvId("a/b")).toBe(false);
    expect(isSafeLocalStoreConvId("a\\b")).toBe(false);
    expect(isSafeLocalStoreConvId("a\0b")).toBe(false);
  });
});

describe("local-store convPath id guard (D-F1)", () => {
  const convRoot = () => join(TEST_ROOT, "local-store", "conversations");

  beforeEach(async () => {
    await mkdir(convRoot(), { recursive: true });
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("getConversation returns null for traversal ids (no escape read)", async () => {
    const get = handlerFor(LOCAL_STORE_CHANNELS.getConversation);
    // Plant a file outside conversations/; traversal id must not reach it.
    const outside = join(TEST_ROOT, "local-store", "secret.json");
    await writeFile(outside, '{"leaked":true}', "utf-8");

    expect(await get(null, "../secret")).toBeNull();
    expect(await get(null, "..\\secret")).toBeNull();
    expect(await get(null, "..")).toBeNull();
    // Outside file untouched and still readable via real path.
    expect(await readFile(outside, "utf-8")).toBe('{"leaked":true}');
  });

  it("putOpenedConversation rejects traversal ids (no escape write)", async () => {
    const put = handlerFor(LOCAL_STORE_CHANNELS.putOpenedConversation);
    const payload: LocalStoreConversationPayload = {
      conversation: {
        id: "../escape",
        title: "evil",
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        lastMessagePreview: null,
        openedAt: Date.now(),
        byteSize: 0,
      },
      messages: [],
      memoryUpdates: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    };

    await expect(put(null, payload)).rejects.toThrow(/invalid/i);

    // Must not create escape.json next to conversations/.
    const escapePath = join(TEST_ROOT, "local-store", "escape.json");
    await expect(readFile(escapePath, "utf-8")).rejects.toThrow();
  });

  it("getConversation still loads a normal UUID file", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const payload: LocalStoreConversationPayload = {
      conversation: {
        id,
        title: "ok",
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessagePreview: null,
        openedAt: Date.now(),
        byteSize: 10,
      },
      messages: [],
      memoryUpdates: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    };
    await writeFile(
      join(convRoot(), `${id}.json`),
      JSON.stringify(payload),
      "utf-8",
    );

    const get = handlerFor(LOCAL_STORE_CHANNELS.getConversation);
    const got = (await get(null, id)) as LocalStoreConversationPayload | null;
    expect(got?.conversation.id).toBe(id);
    expect(got?.conversation.title).toBe("ok");
  });
});
