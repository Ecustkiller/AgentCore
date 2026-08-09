import type { PausedTurnSummary } from "@/api/turn";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearColdInteractions,
  getColdInteractionSnapshot,
  markColdResolved,
  rekeyColdMessageId,
  upsertColdRequired,
} from "../coldInteractions";
import {
  resolveColdResumeKeyFromHosts,
  selectVisibleColdResumes,
} from "../coldResume";

beforeEach(() => {
  clearColdInteractions();
});

const tpPayload = (checkpointId: string) => ({
  checkpoint_id: checkpointId,
  conversation_id: "conv-live",
  primitive: "delegate" as const,
  workers: [
    { run_id: "r1", role: "研究员", task: "调研", depends_on: [] as string[] },
  ],
  tools: ["file_write"],
  motion: "",
  form: "",
  sides: [] as string[],
  max_rounds: 0,
  thorough: true,
  headline: "预计 1 人开工",
});

describe("coldResume · live Interaction authority", () => {
  it("team_preview_required with stamp paints without recovery paused shell", () => {
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "conv-live",
      messageId: "m-server-tp",
      payload: tpPayload("tp-live"),
    });

    const visible = selectVisibleColdResumes({
      conversationId: "conv-live",
      byId: getColdInteractionSnapshot(),
      paused: [],
      hosts: [
        {
          role: "assistant",
          id: "client-uuid",
          serverMessageId: "m-server-tp",
        },
      ],
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.kind).toBe("team_preview");
    expect(visible[0]?.message_id).toBe("m-server-tp");
    expect(visible[0]?.checkpoint_id).toBe("tp-live");
    expect(visible[0]?.headline).toBe("预计 1 人开工");
  });

  it("does not paint clickable card before serverMessageId stamp", () => {
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "conv-live",
      messageId: "client-uuid",
      payload: tpPayload("tp-nostamp"),
    });

    const visible = selectVisibleColdResumes({
      conversationId: "conv-live",
      byId: getColdInteractionSnapshot(),
      paused: [],
      hosts: [
        {
          role: "assistant",
          id: "client-uuid",
          serverMessageId: null,
        },
      ],
    });

    expect(visible).toHaveLength(0);
    expect(
      resolveColdResumeKeyFromHosts(
        [{ role: "assistant", id: "client-uuid", serverMessageId: null }],
        "client-uuid",
      ),
    ).toBeNull();
  });

  it("paints after stamp arrives (client-bound pending → rekey)", () => {
    upsertColdRequired({
      kind: "team_preview",
      conversationId: "conv-live",
      messageId: "client-uuid",
      payload: tpPayload("tp-late-stamp"),
    });

    expect(
      selectVisibleColdResumes({
        conversationId: "conv-live",
        byId: getColdInteractionSnapshot(),
        paused: [],
        hosts: [
          { role: "assistant", id: "client-uuid", serverMessageId: null },
        ],
      }),
    ).toHaveLength(0);

    rekeyColdMessageId("client-uuid", "m-server-late");

    const visible = selectVisibleColdResumes({
      conversationId: "conv-live",
      byId: getColdInteractionSnapshot(),
      paused: [],
      hosts: [
        {
          role: "assistant",
          id: "client-uuid",
          serverMessageId: "m-server-late",
        },
      ],
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.message_id).toBe("m-server-late");
  });

  it("round 2+ new host required replaces tombstone and paints", () => {
    upsertColdRequired({
      kind: "ask_user",
      conversationId: "conv-live",
      messageId: "m-turn1",
      payload: { checkpoint_id: "cp-reuse", question: "第一轮？" },
    });
    markColdResolved({
      kind: "ask_user",
      id: "cp-reuse",
      resolution: { decision: "continue" },
    });

    expect(
      selectVisibleColdResumes({
        conversationId: "conv-live",
        byId: getColdInteractionSnapshot(),
        paused: [],
        hosts: [{ role: "assistant", id: "t1", serverMessageId: "m-turn1" }],
      }),
    ).toHaveLength(0);

    upsertColdRequired({
      kind: "ask_user",
      conversationId: "conv-live",
      messageId: "m-turn2",
      payload: { checkpoint_id: "cp-reuse", question: "第二轮？" },
    });

    const visible = selectVisibleColdResumes({
      conversationId: "conv-live",
      byId: getColdInteractionSnapshot(),
      paused: [],
      hosts: [
        { role: "assistant", id: "t1", serverMessageId: "m-turn1" },
        { role: "assistant", id: "t2", serverMessageId: "m-turn2" },
      ],
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.message_id).toBe("m-turn2");
    expect(visible[0]?.question).toBe("第二轮？");
  });

  it("recovery paused shell fills when IX has no covering pending", () => {
    const shell: PausedTurnSummary = {
      message_id: "m-shell",
      checkpoint_id: "cp-shell",
      kind: "plan_review",
      user_message: "",
      user_message_id: "",
      question: "",
      context: "",
      form: "",
      headline: "",
      motion: "",
      primitive: "delegate",
      max_rounds: 0,
      thorough: true,
      browser_login: false,
      steps: [{ run_id: "r1", role: "研" }],
      pending: [],
    };

    const visible = selectVisibleColdResumes({
      conversationId: "conv-live",
      byId: getColdInteractionSnapshot(),
      paused: [shell],
      hosts: [{ role: "assistant", id: "m-shell", serverMessageId: "m-shell" }],
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.checkpoint_id).toBe("cp-shell");
  });
});
