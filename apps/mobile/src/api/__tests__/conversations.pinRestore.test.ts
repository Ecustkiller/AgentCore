import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  DELETE_CONVERSATION_LABEL,
  deleteConversationConfirmLabel,
} from "@/lib/conversationDeleteCopy";
import { restoreConversation, setConversationPinned } from "../conversations";

const summary = {
  id: "c1",
  title: "定价讨论",
  folder_id: "f1",
  pinned: true,
  archived: false,
  message_count: 24,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-08-09T12:00:00Z",
};

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function fail(status: number, body?: unknown) {
  return {
    ok: false,
    status,
    json: async () => body ?? {},
  };
}

describe("setConversationPinned", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("PATCHes {pinned:true} and returns the updated summary", async () => {
    apiFetch.mockResolvedValue(ok(summary));

    const conv = await setConversationPinned("c1", true);

    expect(apiFetch).toHaveBeenCalledWith("/v1/conversations/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(conv).toEqual(summary);
    expect(conv.pinned).toBe(true);
  });

  it("PATCHes {pinned:false} when unpinning", async () => {
    apiFetch.mockResolvedValue(ok({ ...summary, pinned: false }));

    const conv = await setConversationPinned("c1", false);

    const body = JSON.parse(apiFetch.mock.calls[0][1].body as string) as {
      pinned?: boolean;
    };
    expect(body).toEqual({ pinned: false });
    expect(conv.pinned).toBe(false);
  });

  it("throws on non-2xx", async () => {
    apiFetch.mockResolvedValue(fail(500));
    await expect(setConversationPinned("c1", true)).rejects.toThrow(
      "置顶失败 (500)",
    );
  });
});

describe("restoreConversation", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("POSTs trash restore and returns the live summary", async () => {
    apiFetch.mockResolvedValue(ok(summary));

    const conv = await restoreConversation("c1");

    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/trash/c1/restore",
      { method: "POST" },
    );
    expect(conv.id).toBe("c1");
    expect(conv.pinned).toBe(true);
    expect(conv.folder_id).toBe("f1");
    expect(conv.updated_at).toBe("2026-08-09T12:00:00Z");
  });

  it("409 surfaces the server message and does not pretend success", async () => {
    apiFetch.mockResolvedValue(
      fail(409, { error: { message: "该对话已被清理，无法恢复" } }),
    );

    await expect(restoreConversation("c1")).rejects.toThrow(
      "该对话已被清理，无法恢复",
    );
  });

  it("409 without a parseable body still throws", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error("not json");
      },
    });

    await expect(restoreConversation("c1")).rejects.toThrow("恢复失败 (409)");
  });
});

describe("conversationDeleteCopy", () => {
  it("names「最近删除」as the recovery entry and never claims permanence", () => {
    const confirm = deleteConversationConfirmLabel();
    expect(confirm).toMatch(/最近删除/);
    expect(confirm).not.toMatch(/不可撤销|永久删除/);
    expect(DELETE_CONVERSATION_LABEL).toBe("删除对话");
  });
});
