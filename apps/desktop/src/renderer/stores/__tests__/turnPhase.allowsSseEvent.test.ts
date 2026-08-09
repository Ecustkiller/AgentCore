import {
  type TurnPhase,
  allowsSseEvent,
} from "@/stores/conversation/turnPhase";
import { INTERACTION_KIND_WIRE } from "@agentcore/contract-types";
import { describe, expect, it } from "vitest";

const TERMINAL_OR_STOPPING: TurnPhase[] = [
  "stopping",
  "stopped",
  "completed",
  "failed",
];

describe("allowsSseEvent — interaction *_required on stopping/terminal", () => {
  it.each(TERMINAL_OR_STOPPING)(
    "allows checkpoint_required in phase %s",
    (phase) => {
      expect(allowsSseEvent(phase, "checkpoint_required")).toBe(true);
    },
  );

  it("allows other INTERACTION_KIND_WIRE *_required events when terminal", () => {
    for (const wire of Object.values(INTERACTION_KIND_WIRE)) {
      if (!wire.requiredEvent.endsWith("_required")) continue;
      expect(allowsSseEvent("completed", wire.requiredEvent)).toBe(true);
      expect(allowsSseEvent("stopping", wire.requiredEvent)).toBe(true);
    }
  });

  it("still blocks content mutations on stopping/terminal", () => {
    for (const phase of TERMINAL_OR_STOPPING) {
      expect(allowsSseEvent(phase, "content_delta")).toBe(false);
      expect(allowsSseEvent(phase, "tool_use_start")).toBe(false);
    }
  });

  it.each(TERMINAL_OR_STOPPING)(
    "allows turn_queue_started in phase %s",
    (phase) => {
      expect(allowsSseEvent(phase, "turn_queue_started")).toBe(true);
    },
  );

  it("does not treat question_posted as a free-for-all required event", () => {
    // question_posted is in INTERACTION_KIND_WIRE but is not `*_required`.
    expect(allowsSseEvent("completed", "question_posted")).toBe(false);
  });

  it("keeps workspace_op_required gated (fail-settle lives in dispatch, not allowlist)", () => {
    for (const phase of TERMINAL_OR_STOPPING) {
      expect(allowsSseEvent(phase, "workspace_op_required")).toBe(false);
    }
  });
});
