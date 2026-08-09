import { describe, expect, it } from "vitest";
import {
  messageIdFromTurnEvents,
  prepareResumePausedTurn,
  resumeIdentitySeed,
} from "../resumePausedTurn";

type Turn = {
  id: string;
  userText: string | null;
  events: { type: string; payload?: unknown }[];
};

type Hist = { id: string; role: string };

const SERVER_MID = "srv-turn-1";

function pausedLiveTurn(clientId: string): Turn {
  return {
    id: clientId,
    userText: null,
    events: [
      { type: "message_start", payload: { message_id: SERVER_MID } },
      { type: "run_plan", payload: { execution_id: "exec-1" } },
      {
        type: "message_end",
        payload: { finish_reason: "paused" },
      },
    ],
  };
}

describe("prepareResumePausedTurn (Option A · desktop messageStream.resume intent)", () => {
  it("does not push a second assistant; reuses live turn and keeps one surface", () => {
    const clientId = "client-paused";
    const turns = [pausedLiveTurn(clientId)];
    const before = turns.filter((t) =>
      messageIdFromTurnEvents(t.events),
    ).length;

    const prepared = prepareResumePausedTurn({
      messageId: SERVER_MID,
      turns,
      history: null,
      newTurnId: "should-not-use",
    });

    expect(prepared.source).toBe("live");
    expect(prepared.turnId).toBe(clientId);
    expect(prepared.turns).toHaveLength(before);
    expect(prepared.turns[0].id).toBe(clientId);
    expect(messageIdFromTurnEvents(prepared.turns[0].events)).toBe(SERVER_MID);
    // Cleared to identity seed — resume SSE re-seeds journal (no dual fold).
    expect(prepared.turns[0].events).toEqual(resumeIdentitySeed(SERVER_MID));
  });

  it("is idempotent when the bubble is already resume-seeded (streaming)", () => {
    const clientId = "client-streaming";
    const turns: Turn[] = [
      {
        id: clientId,
        userText: null,
        events: [...resumeIdentitySeed(SERVER_MID)],
      },
    ];

    const prepared = prepareResumePausedTurn({
      messageId: SERVER_MID,
      turns,
      history: null,
      newTurnId: "fallback",
    });

    expect(prepared.source).toBe("live");
    expect(prepared.turns).toHaveLength(1);
    expect(prepared.turnId).toBe(clientId);
    expect(messageIdFromTurnEvents(prepared.turns[0].events)).toBe(SERVER_MID);
  });

  it("promotes history assistant by message_id and strips it (no dual TeamView)", () => {
    const history: Hist[] = [
      { id: "u1", role: "user" },
      { id: SERVER_MID, role: "assistant" },
    ];

    const prepared = prepareResumePausedTurn<Turn, Hist>({
      messageId: SERVER_MID,
      turns: [],
      history,
      newTurnId: "fallback",
    });

    expect(prepared.source).toBe("history");
    expect(prepared.turnId).toBe(SERVER_MID);
    expect(prepared.turns).toHaveLength(1);
    expect(prepared.turns[0].userText).toBeNull();
    expect(prepared.history?.map((m) => m.id)).toEqual(["u1"]);
    expect(messageIdFromTurnEvents(prepared.turns[0].events)).toBe(SERVER_MID);
  });

  it("strips a history twin when reusing a live turn", () => {
    const clientId = "client-live";
    const prepared = prepareResumePausedTurn({
      messageId: SERVER_MID,
      turns: [pausedLiveTurn(clientId)],
      history: [
        { id: "u1", role: "user" },
        { id: SERVER_MID, role: "assistant" },
      ],
      newTurnId: "fallback",
    });

    expect(prepared.source).toBe("live");
    expect(prepared.turns).toHaveLength(1);
    expect(prepared.history?.map((m) => m.id)).toEqual(["u1"]);
  });

  it("falls back to a fresh streaming slot when the paused bubble is missing", () => {
    const prepared = prepareResumePausedTurn<Turn, Hist>({
      messageId: SERVER_MID,
      turns: [],
      history: [{ id: "u1", role: "user" }],
      newTurnId: "new-slot",
    });

    expect(prepared.source).toBe("fallback");
    expect(prepared.turnId).toBe("new-slot");
    expect(prepared.turns).toHaveLength(1);
    expect(prepared.turns[0].id).toBe("new-slot");
    expect(prepared.turns[0].userText).toBeNull();
    expect(messageIdFromTurnEvents(prepared.turns[0].events)).toBe(SERVER_MID);
    // User row untouched — no duplicate user bubble.
    expect(prepared.history?.map((m) => m.id)).toEqual(["u1"]);
  });
});
