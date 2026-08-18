// @vitest-environment jsdom
/**
 * Render gate: golden `projected` → ChatView.
 *
 * Every turn-fold vector has a golden `projected` and is in scope — including
 * `single_agent_*`. The known accepted gap is the production
 * `runs_payload.process` path (no vector walks that wire); do not invent
 * projections or vectors to close it.
 */
import { ChatView } from "@/components/chat/ChatView";
import { loadFixtures } from "@agentcore/protocol-conformance";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
});

const fixtures = loadFixtures();

describe("golden projected → ChatView", () => {
  it("covers every turn-fold vector that has a golden projected", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.some((fx) => fx.name.startsWith("single_agent_"))).toBe(
      true,
    );
  });

  it.each(fixtures.map((fx) => [fx.name, fx] as const))(
    "%s renders without going blank",
    (_name, fx) => {
      render(
        <ChatView content={fx.projected.content} projected={fx.projected} />,
      );
      expect(screen.getByLabelText("对话终态")).toBeTruthy();
      if (fx.projected.runs.length > 0) {
        expect(screen.getByLabelText("团队")).toBeTruthy();
      }
    },
  );
});
