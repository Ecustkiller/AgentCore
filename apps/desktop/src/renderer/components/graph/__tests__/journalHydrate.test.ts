import type { ExecutionJournal } from "@/stores/execution";
import { useExecutionStore } from "@/stores/execution";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type JournalHostMessage,
  type TeamJournalSlot,
  collectTeamJournalSlots,
  journalHydrateIdentity,
  journalHydrateIdentityEqual,
  teamJournalHydrateKey,
  teamJournalsIfIdentityChanged,
} from "../journalHydrate";

function journal(
  n: number,
  extra?: Partial<ExecutionJournal>,
): ExecutionJournal {
  return {
    finishReason: "stop",
    events: Array.from({ length: n }, (_, i) => ({
      type: "run_started",
      timestamp: `2026-01-01T00:00:0${i}.000Z`,
      payload: { run_id: `r${i}`, agent_id: "a1" },
    })),
    ...extra,
  };
}

function teamMsg(
  id: string,
  runs: ExecutionJournal,
  extra?: Partial<JournalHostMessage>,
): JournalHostMessage {
  return { id, role: "assistant", executionId: "exec-1", runs, ...extra };
}

function requireSlots(slots: TeamJournalSlot[] | null): TeamJournalSlot[] {
  expect(slots).not.toBeNull();
  if (!slots) throw new Error("expected team journal slots");
  return slots;
}

const thinPlan = {
  id: "exec-1",
  planType: "multi_agent" as const,
  taskSummary: "半场",
  agents: [{ id: "agent-1", role: "研究员" }],
  runs: [{ id: "run-1", agentId: "agent-1", task: "调研", dependsOn: [] }],
};

const thickerJournal: ExecutionJournal = {
  finishReason: "stop",
  events: [
    {
      type: "run_plan",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        execution_id: "exec-1",
        plan_type: "multi_agent",
        task_summary: "半场",
        agents: [
          { id: "agent-1", role: "研究员" },
          { id: "agent-2", role: "写手" },
        ],
        runs: [
          { id: "run-1", agent_id: "agent-1", task: "调研", depends_on: [] },
          { id: "run-2", agent_id: "agent-2", task: "撰写", depends_on: [] },
        ],
      },
    },
    {
      type: "run_started",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: {
        agent_id: "agent-1",
        run_id: "run-1",
        parent_run_id: null,
        kind: "agent",
      },
    },
    {
      type: "run_started",
      timestamp: "2026-01-01T00:00:02.000Z",
      payload: {
        agent_id: "agent-2",
        run_id: "run-2",
        parent_run_id: null,
        kind: "agent",
      },
    },
  ],
};

describe("teamJournalHydrateKey", () => {
  it("is stable when only content / streaming fields change", () => {
    const runs = journal(2);
    const a = [
      teamMsg("m1", runs),
      { id: "u1", role: "user" as const, executionId: null },
    ];
    const b = [
      teamMsg("m1", runs),
      { id: "u1", role: "user" as const, executionId: null },
      {
        id: "m2",
        role: "assistant" as const,
        executionId: null,
        runs: undefined,
      },
    ];
    expect(teamJournalHydrateKey(a)).toBe(teamJournalHydrateKey(b));
  });

  it("changes when a team journal grows events.length", () => {
    const thin = journal(1);
    const thick = journal(3);
    expect(teamJournalHydrateKey([teamMsg("m1", thin)])).not.toBe(
      teamJournalHydrateKey([teamMsg("m1", thick)]),
    );
  });

  it("changes when a team journal appears", () => {
    const empty = teamJournalHydrateKey([
      { id: "m1", role: "assistant", executionId: "exec-1" },
    ]);
    const withJournal = teamJournalHydrateKey([teamMsg("m1", journal(1))]);
    expect(empty).not.toBe(withJournal);
  });
});

describe("teamJournalsIfIdentityChanged", () => {
  it("returns null on a content tick that keeps the same runs + events.length", () => {
    const runs = journal(2);
    const first = requireSlots(
      teamJournalsIfIdentityChanged([], [teamMsg("m1", runs)]),
    );
    const again = teamJournalsIfIdentityChanged(first, [
      teamMsg("m1", runs),
      { id: "u1", role: "user", executionId: null },
    ]);
    expect(again).toBeNull();
  });

  it("returns slots when a later journal object arrives (half-court catch-up)", () => {
    const thin = journal(1);
    const first = requireSlots(
      teamJournalsIfIdentityChanged([], [teamMsg("m1", thin)]),
    );
    const later = requireSlots(
      teamJournalsIfIdentityChanged(first, [teamMsg("m1", thickerJournal)]),
    );
    expect(later[0].journal).toBe(thickerJournal);
    expect(later[0].journal.events.length).toBeGreaterThan(thin.events.length);
  });

  it("returns slots when events grow on the same journal object", () => {
    const live = journal(1);
    const first = requireSlots(
      teamJournalsIfIdentityChanged([], [teamMsg("m1", live)]),
    );
    live.events.push({
      type: "run_completed",
      timestamp: "2026-01-01T00:00:09.000Z",
      payload: { run_id: "r0", agent_id: "a1" },
    });
    const later = requireSlots(
      teamJournalsIfIdentityChanged(first, [teamMsg("m1", live)]),
    );
    expect(later[0].journal).toBe(live);
    expect(later[0].journal.events).toHaveLength(2);
  });

  it("collects team journals with no !plan gate", () => {
    const slots = collectTeamJournalSlots([
      teamMsg("m1", thickerJournal),
      { id: "plain", role: "assistant", executionId: null, runs: journal(4) },
    ]);
    expect(slots).toEqual([
      {
        key: "m1",
        journal: thickerJournal,
        events: thickerJournal.events.length,
      },
    ]);
  });
});

describe("journalHydrateIdentity (TurnDetailPage / InlineTeamGraph)", () => {
  it("treats the same runs object + events.length as equal", () => {
    const j = journal(2);
    expect(
      journalHydrateIdentityEqual(
        journalHydrateIdentity(j),
        journalHydrateIdentity(j),
      ),
    ).toBe(true);
  });

  it("treats a later journal object as a new identity", () => {
    const thin = journal(1);
    expect(
      journalHydrateIdentityEqual(
        journalHydrateIdentity(thin),
        journalHydrateIdentity(thickerJournal),
      ),
    ).toBe(false);
  });

  it("treats in-place events.length growth as a new identity", () => {
    const j = journal(1);
    const before = journalHydrateIdentity(j);
    j.events.push({
      type: "run_completed",
      timestamp: "2026-01-01T00:00:09.000Z",
      payload: { run_id: "r0", agent_id: "a1" },
    });
    expect(journalHydrateIdentityEqual(before, journalHydrateIdentity(j))).toBe(
      false,
    );
  });
});

describe("canvas hydrate loop (no !plan)", () => {
  beforeEach(() => {
    useExecutionStore.setState({ byId: {} });
  });

  it("hydrates a later journal even when the slot already has a half-court plan", () => {
    const mid = "msg-1";
    useExecutionStore.getState().startExecution(thinPlan, mid);
    expect(useExecutionStore.getState().byId[mid]?.plan?.runs).toHaveLength(1);

    const slots = requireSlots(
      teamJournalsIfIdentityChanged([], [teamMsg(mid, thickerJournal)]),
    );
    for (const { key, journal: next } of slots) {
      useExecutionStore.getState().hydrateFromJournal(key, next);
    }
    expect(
      useExecutionStore.getState().byId[mid]?.plan?.runs.map((r) => r.id),
    ).toEqual(["run-1", "run-2"]);
  });

  it("does not call hydrateFromJournal when only messages content ticks", () => {
    const runs = journal(2);
    const hydrate = vi.fn();
    let prev = requireSlots(
      teamJournalsIfIdentityChanged([], [teamMsg("m1", runs)]),
    );
    for (const { key, journal: next } of prev) hydrate(key, next);

    for (let i = 0; i < 5; i++) {
      const next = teamJournalsIfIdentityChanged(prev, [
        teamMsg("m1", runs),
        { id: "u1", role: "user", executionId: null },
      ]);
      if (next) {
        prev = next;
        for (const { key, journal: slot } of next) hydrate(key, slot);
      }
    }
    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
