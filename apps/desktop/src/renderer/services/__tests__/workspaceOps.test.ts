import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drive the回填 through the REAL api.post by stubbing global fetch (not by
// mocking the api module). vitest instruments its own mock fns and surfaces
// their rejected-promise results as failures even when the SUT catches them; a
// rejection from the real request (user code) is tracked normally, so the
// stale-404 swallow can be asserted cleanly. Mirrors auth.test.ts.
import { BASE_URL } from "@/services/api";
import { performWorkspaceOp } from "@/services/workspaceOps";
import type { WorkspaceOpRequiredPayload } from "@/types/events";

const payload = (
  over: Partial<WorkspaceOpRequiredPayload> = {},
): WorkspaceOpRequiredPayload => ({
  request_id: "r1",
  conversation_id: "c1",
  root_id: "root-1",
  op: "read",
  args: { path: "a.txt" },
  ...over,
});

const stubFsApi = (workspaceOp: unknown) =>
  vi.stubGlobal("window", { fsApi: { workspaceOp } });

const OPS_URL = `${BASE_URL}/v1/conversations/c1/interactions/r1`;

// Minimal Response stand-ins for the two outcomes request() cares about.
const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) });
const errResponse = (status: number, body: string) => ({
  ok: false,
  status,
  text: async () => body,
});

// The body request() POSTs, parsed back from the fetch call (init.body is JSON).
const postedBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("performWorkspaceOp (本地工作区 op 回填)", () => {
  it("runs the op on the bound root and posts the ok result (client_tool kind)", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: "hello" });
    stubFsApi(workspaceOp);

    await performWorkspaceOp(payload(), "c1");

    expect(workspaceOp).toHaveBeenCalledWith("root-1", "read", {
      path: "a.txt",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(OPS_URL);
    expect(postedBody(fetchMock)).toEqual({
      kind: "client_tool",
      ok: true,
      value: "hello",
    });
  });

  it("posts a typed error envelope (kind survives for the tool layer)", async () => {
    stubFsApi(
      vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: "PathNotFound", detail: "x" },
      }),
    );

    await performWorkspaceOp(payload(), "c1");

    expect(postedBody(fetchMock)).toEqual({
      kind: "client_tool",
      ok: false,
      error: { kind: "PathNotFound", detail: "x" },
    });
  });

  it("answers with an IO error when there is no desktop fsApi (web runtime)", async () => {
    vi.stubGlobal("window", {}); // no fsApi

    await performWorkspaceOp(payload(), "c1");

    const body = postedBody(fetchMock) as {
      ok: boolean;
      error: { kind: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe("WorkspaceIOError");
  });

  it("turns a thrown IPC error into an IO error envelope (never leaves the op unanswered)", async () => {
    stubFsApi(vi.fn().mockRejectedValue(new Error("ipc boom")));

    await performWorkspaceOp(payload(), "c1");

    const body = postedBody(fetchMock) as {
      ok: boolean;
      error: { kind: string; detail: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.detail).toContain("ipc boom");
  });

  it("swallows a stale 404 from the resolve endpoint", async () => {
    stubFsApi(vi.fn().mockResolvedValue({ ok: true, value: "x" }));
    fetchMock.mockResolvedValue(errResponse(404, "gone"));

    await expect(performWorkspaceOp(payload(), "c1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
