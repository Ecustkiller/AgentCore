import {
  foldCheckpointMarker,
  foldContentDelta,
  foldContentReset,
  foldReasoningDelta,
  foldToolUseEnd,
  foldToolUsePhase,
  foldToolUseStart,
  messageLaneFromMessage,
} from "@/lib/foldMessageLane";
import type {
  ToolUseEndPayload,
  ToolUseProgressPayload,
  ToolUseStartPayload,
} from "@/types/events";
import { describe, expect, it } from "vitest";

const startPayload = (
  over: Partial<ToolUseStartPayload> = {},
): ToolUseStartPayload => ({
  tool_call_id: "call_1",
  tool_name: "web_search",
  arguments: { query: "深圳天气" },
  ...over,
});

describe("foldMessageLane", () => {
  it("foldContentDelta appends content and process step", () => {
    const base = messageLaneFromMessage({ content: "hi" });
    const next = foldContentDelta(base, " there");
    expect(next.content).toBe("hi there");
    expect(next.process).toEqual([{ kind: "content", text: " there" }]);
  });

  it("foldContentReset clears content and trailing content steps", () => {
    const base = messageLaneFromMessage({
      content: "bad draft",
      process: [
        { kind: "reasoning", text: "think" },
        { kind: "content", text: "bad draft" },
      ],
    });
    const next = foldContentReset(base);
    expect(next.content).toBe("");
    expect(next.process).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "rework" },
    ]);
  });

  it("foldReasoningDelta appends reasoning lane", () => {
    const base = messageLaneFromMessage({ content: "" });
    const next = foldReasoningDelta(base, "hmm");
    expect(next.reasoning).toBe("hmm");
    expect(next.process).toEqual([{ kind: "reasoning", text: "hmm" }]);
  });

  // 工具执行阶段进度 (联网搜索前端展示优化)
  it("foldToolUsePhase stamps a running tool step's phase", () => {
    const started = foldToolUseStart(
      messageLaneFromMessage({ content: "" }),
      startPayload(),
    );
    const next = foldToolUsePhase(started, {
      tool_call_id: "call_1",
      tool_name: "web_search",
      phase: "querying",
    } satisfies ToolUseProgressPayload);
    const step = next.process[0];
    expect(step.kind === "tool" && step.phase).toBe("querying");
  });

  it("foldToolUsePhase no-ops after the tool has ended (not running)", () => {
    const started = foldToolUseStart(
      messageLaneFromMessage({ content: "" }),
      startPayload(),
    );
    const ended = foldToolUseEnd(started, {
      tool_call_id: "call_1",
      tool_name: "web_search",
      result: "ok",
      status: "success",
    } as ToolUseEndPayload);
    const after = foldToolUsePhase(ended, {
      tool_call_id: "call_1",
      tool_name: "web_search",
      phase: "querying",
    } satisfies ToolUseProgressPayload);
    // Same reference (no-op) and no phase leaked onto the resolved step.
    expect(after).toBe(ended);
    const step = after.process[0];
    expect(step.kind === "tool" && step.phase).toBeUndefined();
  });

  it("foldToolUsePhase no-ops for a delegated worker's call (run_id)", () => {
    // A worker call never entered the captain timeline, so there is nothing to stamp.
    const base = messageLaneFromMessage({ content: "" });
    const after = foldToolUsePhase(base, {
      tool_call_id: "call_worker",
      tool_name: "web_search",
      phase: "querying",
      run_id: "run_2",
    } satisfies ToolUseProgressPayload);
    expect(after).toBe(base);
  });

  it("foldCheckpointMarker absorbs trailing content into the card slot", () => {
    const base = messageLaneFromMessage({
      content: "帮你梳理一下起步方案：",
      process: [
        { kind: "reasoning", text: "想一下" },
        { kind: "content", text: "帮你梳理一下起步方案：" },
      ],
    });
    const next = foldCheckpointMarker(base, "cp_1");
    expect(next.content).toBe("");
    expect(next.process).toEqual([
      { kind: "reasoning", text: "想一下" },
      { kind: "checkpoint", checkpoint_id: "cp_1" },
    ]);
  });
});
