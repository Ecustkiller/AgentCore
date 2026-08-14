import { fetchTurnAudit } from "@/services/audit";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
    },
  };
});

const { api } = await import("@/services/api");

describe("fetchTurnAudit", () => {
  it("hits the turn-scoped audit endpoint", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [], total: 0 });
    await fetchTurnAudit("conv-1", "msg-1");
    expect(api.get).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/messages/msg-1/audit",
    );
  });

  it("requests causal graph when includeCausal is true", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [], total: 0 });
    await fetchTurnAudit("conv-1", "msg-1", { includeCausal: true });
    expect(api.get).toHaveBeenCalledWith(
      "/v1/conversations/conv-1/messages/msg-1/audit?include_causal=true",
    );
  });
});
