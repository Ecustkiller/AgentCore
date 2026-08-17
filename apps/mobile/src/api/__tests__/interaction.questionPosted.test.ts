import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { resolveInteraction } from "../interaction";

describe("resolveInteraction question_posted", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    });
  });

  it("POSTs answered settlement", async () => {
    const outcome = await resolveInteraction("c1", "ask1", {
      kind: "question_posted",
      status: "answered",
      answer: "也要 PDF。",
      note: "",
    });
    expect(outcome).toBe("settled");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/interactions/ask1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "question_posted",
          status: "answered",
          answer: "也要 PDF。",
          note: "",
        }),
      },
    );
  });
});
