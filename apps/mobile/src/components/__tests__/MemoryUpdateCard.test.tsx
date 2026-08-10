// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  EPISODIC_SUMMARY_CLAMP_CHARS,
  MemoryUpdateCard,
} from "../MemoryUpdateCard";

describe("MemoryUpdateCard", () => {
  it("renders episodic tip and semantic diff", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          updates={[
            {
              id: "e1",
              createdAt: "2026-07-19T12:00:00Z",
              kind: "episodic",
              summary: "本场摘要：部署讨论",
              items: [],
            },
            {
              id: "s1",
              createdAt: "2026-07-19T13:00:00Z",
              kind: "semantic",
              items: [
                {
                  action: "add",
                  file: "画像",
                  section: "关于用户的事实",
                  scope: "global",
                  content: "用 bun",
                  target: "global/profile",
                },
              ],
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("已记下本场摘要")).toBeTruthy();
    expect(screen.getByText(/部署讨论/)).toBeTruthy();
    expect(screen.getByText("记忆已更新")).toBeTruthy();
    expect(screen.getByText("用 bun")).toBeTruthy();
  });

  it("short episodic summary has no clamp controls", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          updates={[
            {
              id: "e-short",
              createdAt: "2026-07-19T12:00:00Z",
              kind: "episodic",
              summary: "短摘要。",
              items: [],
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("episodic-summary-toggle")).toBeNull();
    const tip = screen.getByText("短摘要。");
    expect(tip.className).not.toContain("is-clamped");
  });

  it("long episodic summary clamps by default and expands on title click", () => {
    const summary = "本场".repeat(EPISODIC_SUMMARY_CLAMP_CHARS);
    expect(summary.length).toBeGreaterThan(EPISODIC_SUMMARY_CLAMP_CHARS);

    render(
      <MemoryRouter>
        <MemoryUpdateCard
          updates={[
            {
              id: "e-long",
              createdAt: "2026-07-19T12:00:00Z",
              kind: "episodic",
              summary,
              items: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    const toggle = screen.getByTestId("episodic-summary-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const tip = screen.getByText(summary);
    expect(tip.className).toContain("is-clamped");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(tip.className).not.toContain("is-clamped");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(tip.className).toContain("is-clamped");
  });

  it("episodic summary with newline is treated as long", () => {
    render(
      <MemoryRouter>
        <MemoryUpdateCard
          updates={[
            {
              id: "e-nl",
              createdAt: "2026-07-19T12:00:00Z",
              kind: "episodic",
              summary: "第一行\n第二行",
              items: [],
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("episodic-summary-toggle")).toBeTruthy();
    expect(screen.getByText(/第一行/).className).toContain("is-clamped");
  });
});
