// @vitest-environment jsdom

import { Markdown } from "@/components/chat/Markdown";
import { SourcePreview } from "@/components/chat/SourcePreview";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Citation } from "@/types/events";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

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
  {
    url: "https://c.example/three",
    title: "Source C",
    snippet: "snip C",
    site: "c.example",
    tier: "official",
  },
];

function renderWithTooltip(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("Markdown citation links (render seam)", () => {
  it("renders in-range [n] as favicon + site links to the real URL", () => {
    renderWithTooltip(
      <Markdown content="see [2] and [1]" citations={CITATIONS} />,
    );
    const linkB = screen.getByRole("link", { name: "Source B" });
    const linkA = screen.getByRole("link", { name: "Source A" });
    expect(linkB.getAttribute("href")).toBe("https://b.example/two");
    expect(linkA.getAttribute("href")).toBe("https://a.example/one");
    expect(linkB.getAttribute("target")).toBe("_blank");
    expect(linkB.getAttribute("rel")).toBe("noreferrer");
    expect(linkB.textContent).toContain("b.example");
    expect(linkA.textContent).toContain("a.example");
    expect(linkB.textContent).not.toContain("Source B");
    expect(linkB.querySelector("img")?.getAttribute("src")).toContain(
      "b.example",
    );
    expect(linkB.className.split(/\s+/)).not.toContain("inline-flex");
    const icon = linkB.querySelector("[aria-hidden]");
    expect(icon).toBeTruthy();
    expect(icon?.className ?? "").not.toMatch(/text-\[0\.65em\]/);
    expect((icon as HTMLElement).style.width).toBe("1em");
    expect((icon as HTMLElement).style.fontSize).toBe("1em");
  });

  it("renders [1]-[2] as two site links without a visible hyphen", () => {
    const { container } = renderWithTooltip(
      <Markdown content="见 [1]-[2]" citations={CITATIONS.slice(0, 2)} />,
    );
    expect(screen.getByRole("link", { name: "Source A" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Source B" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/a\.example\s*-\s*b\.example/);
  });

  it("leaves out-of-range markers as plain text (no source link)", () => {
    renderWithTooltip(
      <Markdown content="ok [1] bad [9]" citations={CITATIONS.slice(0, 2)} />,
    );
    expect(
      screen.getByRole("link", { name: "Source A" }).getAttribute("href"),
    ).toBe("https://a.example/one");
    expect(screen.queryByRole("link", { name: /来源 9/ })).toBeNull();
    expect(screen.getByText(/\[9\]/)).toBeTruthy();
  });

  it("does not invent links when citations are absent", () => {
    renderWithTooltip(<Markdown content="see [1]" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/\[1\]/)).toBeTruthy();
  });

  it("keeps model GFM link text and adds a favicon when the URL is on the ledger", () => {
    renderWithTooltip(
      <Markdown
        content="见 [人民日报](https://a.example/one) 报道"
        citations={CITATIONS}
      />,
    );
    const link = screen.getByRole("link", { name: "人民日报" });
    expect(link.getAttribute("href")).toBe("https://a.example/one");
    expect(link.textContent).toContain("人民日报");
    expect(link.querySelector("img")?.getAttribute("src")).toContain(
      "a.example",
    );
  });

  it("does not decorate a GFM link whose URL is not on the ledger", () => {
    renderWithTooltip(
      <Markdown
        content="见 [其他](https://other.example/x)"
        citations={CITATIONS}
      />,
    );
    const link = screen.getByRole("link", { name: "其他" });
    expect(link.querySelector("img")).toBeNull();
  });

  it("renders consecutive #rN ledger links when knownLedgerIds + citation.id match", () => {
    const ledgerCites: Citation[] = [
      {
        url: "https://a.example/one",
        title: "Source A",
        snippet: "snip A",
        site: "a.example",
        id: "#r5",
        tier: "media",
      },
      {
        url: "https://b.example/two",
        title: "Source B",
        snippet: "snip B",
        site: "b.example",
        id: "#r3",
        tier: "unknown",
      },
      {
        url: "https://c.example/three",
        title: "Source C",
        snippet: "snip C",
        site: "c.example",
        id: "#r11",
        tier: "unknown",
      },
    ];
    const known = new Set(["#r5", "#r3", "#r11"]);
    renderWithTooltip(
      <Markdown
        content="争议 **粗体** #r5#r3#r11"
        citations={ledgerCites}
        knownLedgerIds={known}
      />,
    );
    expect(screen.queryByText(/#r5#r3#r11/)).toBeNull();
    const r5 = screen.getByRole("link", { name: /Source A（#r5）/ });
    expect(r5.getAttribute("href")).toBe("https://a.example/one");
    expect(r5.textContent).toContain("a.example");
    expect(r5.textContent).not.toContain("Source A");
    expect(
      screen
        .getByRole("link", { name: /Source B（#r3）/ })
        .getAttribute("href"),
    ).toBe("https://b.example/two");
    expect(
      screen
        .getByRole("link", { name: /Source C（#r11）/ })
        .getAttribute("href"),
    ).toBe("https://c.example/three");
  });

  it("renders #rN from evidenceLedger when citations[].id is missing (timing fallback)", () => {
    renderWithTooltip(
      <Markdown
        content="见 #r5"
        citations={CITATIONS}
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
      screen
        .getByRole("link", { name: /Ledger R5（#r5）/ })
        .getAttribute("href"),
    ).toBe("https://ledger.example/r5");
  });

  it("renders #rN after a GFM table + bold (debate brief shape)", () => {
    const ledgerCites: Citation[] = [
      {
        url: "https://a.example/5",
        title: "R5",
        snippet: "",
        site: "a.example",
        id: "#r5",
      },
      {
        url: "https://b.example/3",
        title: "R3",
        snippet: "",
        site: "b.example",
        id: "#r3",
      },
      {
        url: "https://c.example/11",
        title: "R11",
        snippet: "",
        site: "c.example",
        id: "#r11",
      },
    ];
    const content = [
      "| 要素 | 内容 |",
      "|---|---|",
      "| **当事人** | 原告 |",
      "",
      "核心法律争议：**四瓣花显著性？** #r5#r3#r11",
    ].join("\n");
    renderWithTooltip(
      <Markdown
        content={content}
        citations={ledgerCites}
        knownLedgerIds={new Set(["#r5", "#r3", "#r11"])}
      />,
    );
    expect(screen.queryByText(/#r5#r3#r11/)).toBeNull();
    expect(screen.getByRole("link", { name: /#r5/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /#r3/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /#r11/ })).toBeTruthy();
  });
});

describe("SourcePreview 已读", () => {
  it("does not show 已读 for search-snippet cites", () => {
    render(<SourcePreview citation={CITATIONS[0]} />);
    expect(screen.queryByText("已读")).toBeNull();
  });

  it("marks 已读 when the page was fetched", () => {
    render(<SourcePreview citation={{ ...CITATIONS[0], deep_read: true }} />);
    expect(screen.getByText("已读")).toBeTruthy();
  });
});
