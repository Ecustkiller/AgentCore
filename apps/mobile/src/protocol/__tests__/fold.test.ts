// 工具执行阶段进度 (联网搜索前端展示优化): the transport-only live sibling extractToolPhases.
// It reads the running-tool phase off raw SSE events (never journaled, kept OUT of the
// ProjectedTurn) so the mobile waiting UI shows 正在检索 / 排队中 / 改用备用引擎 instead of a
// static 进行中 — and clears a tool's phase the moment it ends.

import { extractToolPhases, extractWorkerToolPhases } from "@/protocol/fold";
import type { SSEEvent } from "@agentcore/contract-types";
import { describe, expect, it } from "vitest";

function ev(type: SSEEvent["type"], payload: unknown): SSEEvent {
  return { type, timestamp: "", payload } as SSEEvent;
}

describe("extractToolPhases", () => {
  it("keeps the LATEST phase per running tool_call_id", () => {
    const phases = extractToolPhases([
      ev("tool_use_start", { tool_call_id: "c1", tool_name: "web_search" }),
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "querying",
      }),
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "fallback",
      }),
    ]);
    expect(phases.get("c1")).toBe("fallback");
  });

  it("clears a tool's phase on its matching tool_use_end", () => {
    const phases = extractToolPhases([
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "querying",
      }),
      ev("tool_use_end", {
        tool_call_id: "c1",
        tool_name: "web_search",
        result: "ok",
        status: "success",
      }),
    ]);
    expect(phases.has("c1")).toBe(false);
  });

  it("tracks concurrent tool calls independently", () => {
    const phases = extractToolPhases([
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "queued",
      }),
      ev("tool_use_progress", {
        tool_call_id: "c2",
        tool_name: "web_search",
        phase: "querying",
      }),
      ev("tool_use_end", {
        tool_call_id: "c1",
        tool_name: "web_search",
        result: "ok",
        status: "success",
      }),
    ]);
    expect(phases.get("c1")).toBeUndefined();
    expect(phases.get("c2")).toBe("querying");
  });

  it("returns an empty map for a turn with no progress events (history replay)", () => {
    const phases = extractToolPhases([
      ev("content_delta", { delta: "hi" }),
      ev("tool_use_start", { tool_call_id: "c1", tool_name: "web_search" }),
      ev("tool_use_end", {
        tool_call_id: "c1",
        tool_name: "web_search",
        result: "ok",
        status: "success",
      }),
    ]);
    expect(phases.size).toBe(0);
  });
});

describe("extractWorkerToolPhases", () => {
  it("keeps the LATEST phase per worker run_id", () => {
    const phases = extractWorkerToolPhases([
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "queued",
        run_id: "run-2",
      }),
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "querying",
        run_id: "run-2",
      }),
    ]);
    expect(phases.get("run-2")).toEqual({
      phase: "querying",
      toolName: "web_search",
    });
  });

  it("ignores CEO-scoped progress (no run_id)", () => {
    const phases = extractWorkerToolPhases([
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "querying",
      }),
    ]);
    expect(phases.size).toBe(0);
  });

  it("clears a worker phase on tool_use_end with run_id", () => {
    const phases = extractWorkerToolPhases([
      ev("tool_use_progress", {
        tool_call_id: "c1",
        tool_name: "web_search",
        phase: "fallback",
        run_id: "run-9",
      }),
      ev("tool_use_end", {
        tool_call_id: "c1",
        tool_name: "web_search",
        result: "ok",
        status: "success",
        run_id: "run-9",
      }),
    ]);
    expect(phases.size).toBe(0);
  });
});
