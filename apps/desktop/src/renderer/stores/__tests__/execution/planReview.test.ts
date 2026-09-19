import type { SSEEvent } from "@/types/events";
import { describe, expect, it } from "vitest";
import { frameFromEvent, projectExecution } from "../../execution";
import { plan, started } from "./fixtures";

describe("leftover plan_review frames skip", () => {
  it("frameFromEvent returns null for leftover plan_review_*", () => {
    expect(
      frameFromEvent({
        type: "plan_review_required" as SSEEvent["type"],
        timestamp: "",
        payload: {
          checkpoint_id: "c1",
          conversation_id: "a",
          steps: [{ run_id: "run-1", role: "R", summary: "s" }],
          pending: [],
        },
      } as SSEEvent),
    ).toBeNull();
    expect(
      frameFromEvent({
        type: "plan_review_resolved" as SSEEvent["type"],
        timestamp: "",
        payload: { checkpoint_id: "c1", decision: "stop", note: "" },
      } as SSEEvent),
    ).toBeNull();
  });

  it("does not stamp run.checkpoint from leftover events", () => {
    const exec = projectExecution(
      plan,
      [started("agent-1", "run-1")],
      "running",
    );
    expect(exec.runs.every((r) => r.checkpoint === null)).toBe(true);
  });
});
