// @vitest-environment jsdom
/**
 * Regression ratchet for the mermaid「渲染失败」false positive.
 *
 * mermaid v11 inlines its theme stylesheet — which contains an `.error-icon{…}`
 * rule — into EVERY rendered diagram's <style>. The old success-check
 * `svg.includes("error-icon")` therefore matched 100% of *valid* charts and
 * rejected them all as「图表语法无效」. Here mermaid is mocked to return a healthy
 * flowchart SVG carrying exactly that CSS; the component MUST render it, not fall
 * back to source. The block comment keeps the @vitest-environment directive
 * file-leading past organizeImports.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagramBlock } from "../Diagram";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn().mockResolvedValue(true),
    // Healthy render output — a real flowchart SVG whose inlined theme CSS
    // carries the `.error-icon` rule mermaid ships with every diagram.
    render: vi.fn().mockResolvedValue({
      svg:
        '<svg id="acmmd-1" aria-roledescription="flowchart-v2" class="flowchart">' +
        "<style>#acmmd-1 .error-icon{fill:#552222;}</style>" +
        '<g class="node"><rect width="10" height="10" /></g></svg>',
    }),
  },
}));

afterEach(cleanup);

describe("MermaidDiagram · 合法图不得误报渲染失败", () => {
  it("renders a healthy SVG that contains .error-icon theme CSS", async () => {
    const { container } = render(
      <DiagramBlock
        kind="mermaid"
        code={'flowchart LR\n  A["用户提问"] --> B["直答"]'}
        streaming={false}
      />,
    );

    // Success path injects mermaid's <svg class="flowchart"> into the card.
    await waitFor(() =>
      expect(container.querySelector("svg.flowchart")).not.toBeNull(),
    );
    // ...and never degrades to the CodeFallback「渲染失败」card.
    expect(screen.queryByText("渲染失败")).toBeNull();
  });
});
