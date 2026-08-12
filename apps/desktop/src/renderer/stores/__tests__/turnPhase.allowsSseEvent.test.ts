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

  it.each(TERMINAL_OR_STOPPING)(
    "allows user_interjection and turn_queued in phase %s",
    (phase) => {
      expect(allowsSseEvent(phase, "user_interjection")).toBe(true);
      expect(allowsSseEvent(phase, "turn_queued")).toBe(true);
    },
  );

  it("does not treat question_posted as a free-for-all required event", () => {
    // question_posted is in INTERACTION_KIND_WIRE but is not `*_required`.
    expect(allowsSseEvent("completed", "question_posted")).toBe(false);
  });

  it("keeps workspace_op_required gated on conversation SSE allowlist", () => {
    // Cloud CLIENT_TOOL rides the device fulfill stream (no turnPhase). Sidecar
    // fulfills before the gate in dispatchSSEEvent. Allowlist still excludes these
    // so a stray conversation-bus frame does not pass as a normal SSE mutation.
    for (const phase of TERMINAL_OR_STOPPING) {
      expect(allowsSseEvent(phase, "workspace_op_required")).toBe(false);
    }
  });

  it("keeps host_op_required gated on conversation SSE allowlist", () => {
    for (const phase of TERMINAL_OR_STOPPING) {
      expect(allowsSseEvent(phase, "host_op_required")).toBe(false);
    }
  });

  it("allows post-turn auto-snapshot signals on terminal", () => {
    for (const phase of ["completed", "failed", "stopped"] as const) {
      expect(allowsSseEvent(phase, "workspace_snapshot_done")).toBe(true);
      expect(allowsSseEvent(phase, "workspace_snapshot_failed")).toBe(true);
    }
  });
});
