/**
 * Desktop INTERACTION_REGISTRY live-kind bags.
 *
 * Kind bags are derived from registered rows × INTERACTION_KIND_WIRE flags.
 */
import { INTERACTION_KIND_WIRE } from "@agentcore/contract-types";
import { INTERACTION_CARD_NAME as SHARED_INTERACTION_CARD_NAME } from "@agentcore/protocol-fold-kit";
import { describe, expect, it } from "vitest";
import {
  COLD_RESUME_KINDS,
  HOT_GATE_INTERACTION_KINDS,
  HOT_INTERACTION_KINDS,
  INTERACTION_CARD_NAME,
  INTERACTION_REGISTRY,
  LEFTOVER_INTERACTION_SSE_TYPES,
  STAGE_INTERACTION_KINDS,
  hotGateKindTitle,
  isColdResumeKind,
  isHotGateInteractionKind,
  isHotInteractionKind,
  isLeftoverInteractionSse,
  isStageInteractionKind,
  submitPathOf,
} from "../registry";

const REGISTERED = INTERACTION_REGISTRY.map((d) => d.kind);

describe("INTERACTION_REGISTRY live kinds", () => {
  it("registers live UserInteractionKind rows (no kickoff / plan_review card)", () => {
    expect([...new Set(REGISTERED)].sort()).toEqual(
      ["approval", "ask_user", "escalation"].sort(),
    );
    for (const kind of REGISTERED) {
      expect(INTERACTION_KIND_WIRE[kind]).toBeDefined();
    }
  });
});

describe("kind bags derived from INTERACTION_KIND_WIRE flags", () => {
  it("HOT_INTERACTION_KINDS = hot (current: approval / escalation)", () => {
    expect(HOT_INTERACTION_KINDS).toEqual(["approval", "escalation"]);
    for (const kind of REGISTERED) {
      expect(isHotInteractionKind(kind)).toBe(INTERACTION_KIND_WIRE[kind].hot);
    }
  });

  it("COLD_RESUME_KINDS = pausesTurn && !hot (current: ask_user)", () => {
    expect(COLD_RESUME_KINDS).toEqual(["ask_user"]);
    for (const kind of REGISTERED) {
      const w = INTERACTION_KIND_WIRE[kind];
      expect(isColdResumeKind(kind)).toBe(w.pausesTurn && !w.hot);
    }
    expect(isColdResumeKind("team_preview")).toBe(false);
    expect(isColdResumeKind("plan_review")).toBe(false);
  });

  it("HOT_GATE_INTERACTION_KINDS = hot && pausesTurn (current: approval)", () => {
    expect(HOT_GATE_INTERACTION_KINDS).toEqual(["approval"]);
    for (const kind of REGISTERED) {
      const w = INTERACTION_KIND_WIRE[kind];
      expect(isHotGateInteractionKind(kind)).toBe(w.hot && w.pausesTurn);
    }
  });

  it("INTERACTION_CARD_NAME is the shared kit table; unknown keys do not inherit 工具审批", () => {
    expect(INTERACTION_CARD_NAME).toBe(SHARED_INTERACTION_CARD_NAME);
    expect(hotGateKindTitle("approval")).toBe("工具审批");
    expect(hotGateKindTitle("synthetic_hot_gate")).toBe("synthetic_hot_gate");
    expect(hotGateKindTitle("synthetic_hot_gate")).not.toBe(
      INTERACTION_CARD_NAME.approval,
    );
  });

  it("STAGE_INTERACTION_KINDS = reconnectAnswerable && !hot && !pausesTurn (none: leftover stage_card is not answerable)", () => {
    expect(STAGE_INTERACTION_KINDS).toEqual([]);
    for (const kind of REGISTERED) {
      const w = INTERACTION_KIND_WIRE[kind];
      expect(isStageInteractionKind(kind)).toBe(
        w.reconnectAnswerable && !w.hot && !w.pausesTurn,
      );
    }
  });

  it("submitPathOf matches the flag priority (hot / cold)", () => {
    expect(submitPathOf("approval")).toBe("hot");
    expect(submitPathOf("escalation")).toBe("hot");
    expect(submitPathOf("ask_user")).toBe("cold");
    for (const kind of REGISTERED) {
      const w = INTERACTION_KIND_WIRE[kind];
      const path = submitPathOf(kind);
      if (w.hot) expect(path).toBe("hot");
      else if (w.pausesTurn) expect(path).toBe("cold");
      else throw new Error(`unexpected leftover submit path for ${kind}`);
    }
  });

  it("leftover plan_review / team_preview SSE types are consume-and-skip", () => {
    expect([...LEFTOVER_INTERACTION_SSE_TYPES].sort()).toEqual(
      [
        "plan_review_required",
        "plan_review_resolved",
        "team_preview_required",
        "team_preview_resolved",
      ].sort(),
    );
    expect(isLeftoverInteractionSse("plan_review_required")).toBe(true);
    expect(isLeftoverInteractionSse("plan_review_resolved")).toBe(true);
    expect(isLeftoverInteractionSse("checkpoint_required")).toBe(false);
  });
});
