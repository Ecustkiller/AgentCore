import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { createConversation } from "../conversations";

describe("createConversation folder_id", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "c1" }),
    });
  });

  it("omits folder_id for a bare 快速对话", async () => {
    await createConversation(undefined, { client_request_id: "r1" });
    const body = JSON.parse(apiFetch.mock.calls[0][1].body as string) as {
      folder_id?: string;
    };
    expect(body.folder_id).toBeUndefined();
  });

  it("files the chat into an existing cloud folder at birth", async () => {
    await createConversation(undefined, { folder_id: "f1" });
    const body = JSON.parse(apiFetch.mock.calls[0][1].body as string) as {
      folder_id?: string;
    };
    expect(body.folder_id).toBe("f1");
  });
});
