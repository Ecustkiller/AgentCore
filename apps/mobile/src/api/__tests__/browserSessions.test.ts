/**
 * Mobile browser sessions list — wire → camelCase mapping + path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("@/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { listBrowserSessions, listSessions } from "../browserSessions";

beforeEach(() => {
  apiFetch.mockReset();
});

describe("listBrowserSessions", () => {
  it("GETs sessions and maps snake_case wire → camelCase", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            session_id: "s1",
            conversation_id: "c1",
            host_kind: "sandbox",
            control: "agent",
            run_id: "r1",
            created_at: 100,
            last_used: 200,
            url: "https://example.com",
            title: "Example",
          },
        ],
        active_session_id: "s1",
      }),
    });

    const out = await listBrowserSessions("c1");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/browser/sessions",
    );
    expect(out).toEqual({
      sessions: [
        {
          sessionId: "s1",
          conversationId: "c1",
          hostKind: "sandbox",
          control: "agent",
          runId: "r1",
          createdAt: 100,
          lastUsed: 200,
          url: "https://example.com",
          title: "Example",
        },
      ],
      activeSessionId: "s1",
    });
  });

  it("listSessions alias encodes conversation id", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], active_session_id: null }),
    });
    await listSessions("a/b");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/conversations/a%2Fb/browser/sessions",
    );
  });

  it("throws on non-OK", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(listBrowserSessions("c1")).rejects.toThrow(/404/);
  });
});
