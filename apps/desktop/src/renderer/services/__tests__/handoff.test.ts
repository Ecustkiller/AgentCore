import { CSRF_FAILED_MESSAGE, StreamError, describeError } from "@/lib/errors";
import { buildReviewRows, buildSelections } from "@/lib/handoff-review";
import { BASE_URL, api, captureCsrf, clearCsrfToken } from "@/services/api";
import { performWorkspaceOp } from "@/services/workspaceOps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyHandoffJob,
  discardHandoffJob,
  dispatchHandoffJob,
  getHandoffDiff,
  readLocalShas,
  resolveHandoffCardPhase,
} from "../handoff";

vi.mock("@/services/workspaceOps", () => ({
  performWorkspaceOp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn() },
  };
});

const performOp = vi.mocked(performWorkspaceOp);
const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

/** Build a one-shot SSE Response whose body yields the given events then closes. */
function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const postedBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

/** 第 `call` 次发送实际带上的 CSRF 令牌（未带 = undefined）。 */
const sentToken = (
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
): string | undefined => {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return (init.headers as Record<string, string>)["X-CSRF-Token"];
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  performOp.mockReset();
  performOp.mockResolvedValue(undefined);
  apiGet.mockReset();
  apiPost.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 令牌活在 api 模块的内存里，跨用例会串。
  clearCsrfToken();
});

describe("dispatchHandoffJob", () => {
  it("POSTs {task}, ignores workspace_op_required on handoff SSE, returns job ids", async () => {
    const opPayload = {
      request_id: "op-1",
      conversation_id: "c1",
      root_id: "root-1",
      op: "archive",
      args: {},
    };
    fetchMock.mockResolvedValue(
      sseResponse([
        { type: "workspace_op_required", payload: opPayload },
        {
          type: "handoff_job_started",
          payload: {
            job_id: "job-1",
            conversation_id: "c1",
            job_conversation_id: "job-conv-1",
          },
        },
      ]),
    );

    const started = await dispatchHandoffJob("c1", "调研竞品");

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/v1/conversations/c1/workspace/handoff/dispatch`,
    );
    expect(postedBody(fetchMock)).toEqual({ task: "调研竞品" });
    // CLIENT_TOOL ops ride the device fulfill stream — handoff SSE must not
    // double-fulfill the same request_id.
    expect(performOp).not.toHaveBeenCalled();
    expect(started).toEqual({
      jobId: "job-1",
      jobConversationId: "job-conv-1",
    });
  });
});

describe("交接流失败收口", () => {
  it("parses the refusal body so a CSRF 403 reads like everywhere else", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "CSRF_FAILED",
            message: "CSRF token missing or invalid. Re-login and retry.",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const err = await dispatchHandoffJob("c1", "调研竞品").catch(
      (e: unknown) => e,
    );

    // Used to throw on the status alone: same backend refusal, different words.
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).code).toBe("CSRF_FAILED");
    expect(describeError(err)?.message).toBe(CSRF_FAILED_MESSAGE);
  });
});

/**
 * 交接 POST 也吃 CSRF 403 自愈（与 `api.request` / `authedFetch` 同一条判据）。
 *
 * 「重发一条会派云端作业的 POST」之所以不会派两份，全由 `isReplayableCsrfRejection`
 * 保证——它只在 middleware 前置拒绝、handler 从未执行、且服务端回发了新令牌时才为真。
 */
describe("交接流 CSRF 403 自愈", () => {
  const CSRF_BODY = JSON.stringify({
    error: {
      code: "CSRF_FAILED",
      message: "CSRF token missing or invalid. Re-login and retry.",
    },
  });

  /** 一次被拒的派发；`reissued` = 这次拒绝随手回发的替换令牌。 */
  const csrfRejection = (reissued?: string): Response =>
    new Response(CSRF_BODY, {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        ...(reissued ? { "X-CSRF-Token": reissued } : {}),
      },
    });

  it("可自愈的 403 重放一次，第二次带上服务端回发的新令牌", async () => {
    captureCsrf(
      new Response(null, { headers: { "X-CSRF-Token": "tok-stale" } }),
    );
    fetchMock
      .mockResolvedValueOnce(csrfRejection("tok-reissued"))
      .mockResolvedValueOnce(
        sseResponse([
          {
            type: "handoff_job_started",
            payload: {
              job_id: "job-1",
              conversation_id: "c1",
              job_conversation_id: "job-conv-1",
            },
          },
        ]),
      );

    const started = await dispatchHandoffJob("c1", "调研竞品");

    expect(started).toEqual({
      jobId: "job-1",
      jobConversationId: "job-conv-1",
    });
    // doFetch 每次调用重算 header——重放靠这个才带得上刚换发的令牌。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentToken(fetchMock, 0)).toBe("tok-stale");
    expect(sentToken(fetchMock, 1)).toBe("tok-reissued");
  });

  it("没回发令牌的 403 只发一次，原样失败", async () => {
    // 无 header = 服务端刻意不重新武装（呈上的令牌签给了别的会话），重发只会以
    // *那个*会话的身份派活，所以必须保持失败。
    fetchMock.mockResolvedValueOnce(csrfRejection());

    const err = await dispatchHandoffJob("c1", "调研竞品").catch(
      (e: unknown) => e,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).status).toBe(403);
    expect((err as StreamError).code).toBe("CSRF_FAILED");
  });
});

describe("getHandoffDiff", () => {
  it("maps snake_case wire rows into camelCase HandoffDiff", async () => {
    apiGet.mockResolvedValueOnce({
      job_id: "job-1",
      data: [
        {
          path: "a.txt",
          change_type: "modified",
          base_sha: "b1",
          result_sha: "r1",
          is_binary: false,
          content: "hi",
          size_bytes: 2,
        },
      ],
      total: 1,
      added: 0,
      modified: 1,
      deleted: 0,
    });

    const diff = await getHandoffDiff("c1", "job-1");

    expect(apiGet).toHaveBeenCalledWith(
      "/v1/conversations/c1/handoff/jobs/job-1/diff",
    );
    expect(diff).toEqual({
      jobId: "job-1",
      changes: [
        {
          path: "a.txt",
          changeType: "modified",
          baseSha: "b1",
          resultSha: "r1",
          isBinary: false,
          content: "hi",
          sizeBytes: 2,
        },
      ],
      total: 1,
      added: 0,
      modified: 1,
      deleted: 0,
    });
  });
});

describe("applyHandoffJob", () => {
  it("POSTs snake_case selections and maps handoff_apply_done", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          type: "handoff_apply_done",
          payload: {
            job_id: "job-1",
            conversation_id: "c1",
            results: [
              {
                path: "a.txt",
                status: "applied",
                change_type: "modified",
                detail: "",
              },
              {
                path: "b.txt",
                status: "conflict",
                change_type: "modified",
                detail: "local drifted",
              },
            ],
            applied: 1,
            skipped: 0,
            conflicts: 1,
            errors: 0,
          },
        },
      ]),
    );

    const summary = await applyHandoffJob("c1", "job-1", [
      {
        path: "a.txt",
        decision: "cloud",
        localSha: "b1",
        force: false,
      },
      {
        path: "b.txt",
        decision: "cloud",
        localSha: "x9",
        force: true,
      },
    ]);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/v1/conversations/c1/handoff/jobs/job-1/apply`,
    );
    expect(postedBody(fetchMock)).toEqual({
      selections: [
        {
          path: "a.txt",
          decision: "cloud",
          local_sha: "b1",
          force: false,
        },
        {
          path: "b.txt",
          decision: "cloud",
          local_sha: "x9",
          force: true,
        },
      ],
    });
    expect(summary).toEqual({
      jobId: "job-1",
      results: [
        {
          path: "a.txt",
          status: "applied",
          changeType: "modified",
          detail: "",
        },
        {
          path: "b.txt",
          status: "conflict",
          changeType: "modified",
          detail: "local drifted",
        },
      ],
      applied: 1,
      skipped: 0,
      conflicts: 1,
      errors: 0,
    });
  });
});

describe("readLocalShas (假 fsApi)", () => {
  it("hashes readable files and nulls missing / non-desktop", async () => {
    const workspaceOp = vi.fn(
      async (_root: string, _op: string, args: { path: string }) => {
        if (args.path === "ok.txt") {
          return { ok: true, value: btoa("hello") };
        }
        return { ok: false, error: { kind: "PathNotFound", detail: "" } };
      },
    );
    vi.stubGlobal("window", { fsApi: { workspaceOp } });

    const map = await readLocalShas("root-1", ["ok.txt", "gone.txt"]);

    expect(workspaceOp).toHaveBeenCalledWith("root-1", "read_bytes", {
      path: "ok.txt",
    });
    expect(map.get("ok.txt")).toMatch(/^[0-9a-f]{64}$/);
    expect(map.get("gone.txt")).toBeNull();

    vi.stubGlobal("window", {});
    const empty = await readLocalShas("root-1", ["x.txt"]);
    expect(empty.get("x.txt")).toBeNull();
  });
});

describe("应用前重哈希冲突门 (review → fresh shas → apply body)", () => {
  /**
   * Mirrors BackgroundTaskReview.onApply: re-read local shas right before
   * apply so a file edited since the review opened becomes a conflict (force
   * when the user still picks cloud) rather than a silent clobber.
   */
  it("fresh local drift flips clean→conflict and sets force on cloud pick", async () => {
    const change = {
      path: "a.txt",
      changeType: "modified" as const,
      baseSha: "base",
      resultSha: "result",
      isBinary: false,
      content: "cloud",
      sizeBytes: 5,
    };
    // Review-time: local still at base → clean, default cloud.
    const reviewRows = buildReviewRows([change], new Map([["a.txt", "base"]]));
    expect(reviewRows[0].verdict).toBe("clean");
    expect(reviewRows[0].decision).toBe("cloud");

    // Apply-time rehash: disk drifted → conflict; user keeps cloud → force.
    const freshShas = new Map<string, string | null>([["a.txt", "drifted"]]);
    const applyRows = buildReviewRows([change], freshShas);
    expect(applyRows[0].verdict).toBe("conflict");
    applyRows[0].decision = "cloud";
    const selections = buildSelections(applyRows);
    expect(selections).toEqual([
      {
        path: "a.txt",
        decision: "cloud",
        localSha: "drifted",
        force: true,
      },
    ]);

    fetchMock.mockResolvedValue(
      sseResponse([
        {
          type: "handoff_apply_done",
          payload: {
            job_id: "job-1",
            conversation_id: "c1",
            results: [
              {
                path: "a.txt",
                status: "applied",
                change_type: "modified",
                detail: "forced",
              },
            ],
            applied: 1,
            skipped: 0,
            conflicts: 0,
            errors: 0,
          },
        },
      ]),
    );

    await applyHandoffJob("c1", "job-1", selections);
    expect(postedBody(fetchMock).selections[0]).toEqual({
      path: "a.txt",
      decision: "cloud",
      local_sha: "drifted",
      force: true,
    });
  });
});

describe("discardHandoffJob", () => {
  it("POSTs discard path and maps discarded job", async () => {
    apiPost.mockResolvedValueOnce({
      id: "job-1",
      source_conversation_id: "c1",
      job_conversation_id: "job-conv-1",
      base_snapshot_id: "snap-base",
      result_snapshot_id: "snap-result",
      task: "调研竞品",
      status: "discarded",
      error: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T01:00:00Z",
      finished_at: "2026-07-10T01:00:00Z",
    });

    const job = await discardHandoffJob("c1", "job-1");

    expect(apiPost).toHaveBeenCalledWith(
      "/v1/conversations/c1/handoff/jobs/job-1/discard",
    );
    expect(job.status).toBe("discarded");
    expect(job.id).toBe("job-1");
  });
});

describe("resolveHandoffCardPhase (§7.6)", () => {
  it("prefers backend applied/discarded over mergedOptimistic", () => {
    expect(resolveHandoffCardPhase({ status: "applied" }, false)).toBe(
      "applied",
    );
    expect(resolveHandoffCardPhase({ status: "discarded" }, true)).toBe(
      "discarded",
    );
  });

  it("maps succeeded+optimistic → applied; bare succeeded → awaiting", () => {
    expect(resolveHandoffCardPhase({ status: "succeeded" }, false)).toBe(
      "awaiting",
    );
    expect(resolveHandoffCardPhase({ status: "succeeded" }, true)).toBe(
      "applied",
    );
  });
});
