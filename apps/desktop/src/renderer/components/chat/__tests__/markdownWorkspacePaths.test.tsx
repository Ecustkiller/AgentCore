// @vitest-environment jsdom

import { Markdown } from "@/components/chat/Markdown";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

describe("Markdown body paths stay code", () => {
  it("does not turn a prose path into a link or a file button", () => {
    const { container } = render(
      <Markdown content="已写入 AgentCore/文档/工作稿/白板PRD.md。" />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("白板PRD.md");
  });

  it("keeps directory, symbol, and file-shaped code on the same code chip", () => {
    render(
      <Markdown content="见 `evals/cases/routing/`、`delegate_parallel_compare` 与 `tools/builtin/delegate/schema.py`。" />,
    );
    for (const label of [
      "evals/cases/routing/",
      "delegate_parallel_compare",
      "tools/builtin/delegate/schema.py",
    ]) {
      expect(screen.getByText(label).tagName).toBe("CODE");
    }
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a relative markdown link as code, not a blue file opener", () => {
    render(
      <Markdown content="见 [schema.py](tools/builtin/delegate/schema.py)。" />,
    );
    const mark = screen.getByText("schema.py");
    expect(mark.tagName).toBe("CODE");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps a real https link", () => {
    render(<Markdown content="见 [文档](https://example.com/a)。" />);
    expect(
      screen.getByRole("link", { name: "文档" }).getAttribute("href"),
    ).toBe("https://example.com/a");
  });

  it("leaves fence contents untouched", () => {
    render(
      <Markdown content={"```\nAgentCore/文档/工作稿/白板PRD.md\n```"} />,
    );
    expect(screen.queryByRole("button", { name: /打开 / })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByText("AgentCore/文档/工作稿/白板PRD.md").closest("pre"),
    ).toBeTruthy();
  });
});
