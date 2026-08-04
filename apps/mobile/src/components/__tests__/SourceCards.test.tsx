// @vitest-environment jsdom

import { SourceCards, buildCitationDisplayMap } from "@/components/SourceCards";
import type { Citation } from "@agentcore/contract-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const CITATIONS: Citation[] = [
  {
    url: "https://a.example/one",
    title: "One",
    site: "a.example",
    tier: "official",
  },
  {
    url: "https://b.example/two",
    title: "Two",
    site: "b.example",
    tier: "media",
  },
  {
    url: "https://c.example/three",
    title: "Three",
    site: "c.example",
    tier: "unknown",
  },
  {
    url: "https://d.example/four",
    title: "Four",
    site: "d.example",
    tier: "weak",
  },
];

describe("buildCitationDisplayMap", () => {
  it("orders by first appearance and trails uncited", () => {
    const display = buildCitationDisplayMap("cite [3] then [1]", 3);
    expect([...display.toDisplay.entries()]).toEqual([
      [3, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(display.rows.map((r) => r.poolIndex)).toEqual([2, 0, 1]);
    expect(display.rows.map((r) => r.cited)).toEqual([true, true, false]);
  });
});

describe("SourceCards", () => {
  it("shows display numbers from content map and orders cited first", () => {
    render(
      <SourceCards items={CITATIONS.slice(0, 3)} content="cite [3] then [1]" />,
    );
    const links = screen.getAllByRole("link");
    expect(links[0].getAttribute("href")).toBe("https://c.example/three");
    expect(links[0].textContent).toMatch(/^1/);
    expect(links[1].getAttribute("href")).toBe("https://a.example/one");
    expect(links[1].textContent).toMatch(/^2/);
    expect(links[2].getAttribute("href")).toBe("https://b.example/two");
    expect(links[2].textContent).toMatch(/^3/);
  });

  it("renders tier badges on collapsed pills", () => {
    render(<SourceCards items={CITATIONS.slice(0, 3)} />);
    expect(screen.getByText("官方")).toBeTruthy();
    expect(screen.getByText("媒体")).toBeTruthy();
    expect(screen.getByText("待评")).toBeTruthy();
  });

  it("collapses to pills and expands to a list with snippets", () => {
    const items = CITATIONS.map((c, i) =>
      i === 0 ? { ...c, snippet: "alpha snippet" } : c,
    );
    render(<SourceCards items={items} />);
    expect(screen.getByText("来源 4")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByText("alpha snippet")).toBeNull();

    fireEvent.click(screen.getByText("+1"));
    expect(screen.getByText("alpha snippet")).toBeTruthy();
    expect(screen.getByText("收起")).toBeTruthy();

    fireEvent.click(screen.getByText("收起"));
    expect(screen.queryByText("alpha snippet")).toBeNull();
  });
});
