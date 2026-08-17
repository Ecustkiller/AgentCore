import { foldToProjectedTurn } from "@/protocol/conformanceFold";
import type { SSEEvent } from "@agentcore/contract-types";
import { diffProjected, loadFixtures } from "@agentcore/protocol-conformance";
import { describe, expect, it } from "vitest";

describe("conformanceFold · non-blocking ask 三态", () => {
  it.each([
    "single_agent_non_blocking_ask",
    "single_agent_non_blocking_ask_answered",
    "single_agent_non_blocking_ask_discarded",
  ])("%s aligns with golden", (name) => {
    const fixture = loadFixtures().find((f) => f.name === name);
    expect(fixture).toBeTruthy();
    if (!fixture) return;
    const actual = foldToProjectedTurn(fixture.events as SSEEvent[]);
    expect(diffProjected(fixture.projected, actual)).toEqual([]);
  });
});
