// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({
  hasTerminalRun: vi.fn(() => true),
}));

import { hasTerminalRun } from "@/lib/capabilities";
import { CodeBlock } from "../CodeBlock";

const hasTerminalRunMock = vi.mocked(hasTerminalRun);

function renderBashBlock(code = "echo hello") {
  return render(
    <CodeBlock>
      <code className="language-bash">{code}</code>
    </CodeBlock>,
  );
}

beforeEach(() => {
  hasTerminalRunMock.mockReturnValue(true);
  window.terminalApi = { runBash: vi.fn(async () => ({ ok: true })) };
});

afterEach(() => {
  cleanup();
  delete window.terminalApi;
});

describe("CodeBlock bash run action", () => {
  it("shows 在终端运行 for bash blocks when terminal capability is available", () => {
    renderBashBlock();
    expect(screen.getByRole("button", { name: "在终端运行" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
  });

  it("hides 在终端运行 for non-bash languages", () => {
    render(
      <CodeBlock>
        <code className="language-python">print(1)</code>
      </CodeBlock>,
    );
    expect(screen.queryByRole("button", { name: "在终端运行" })).toBeNull();
  });

  it("hides 在终端运行 when terminal capability is unavailable", () => {
    hasTerminalRunMock.mockReturnValue(false);
    renderBashBlock();
    expect(screen.queryByRole("button", { name: "在终端运行" })).toBeNull();
  });

  it("invokes terminalApi.runBash with block text on click", async () => {
    const runBash = vi.fn(async () => ({ ok: true }));
    window.terminalApi = { runBash };
    renderBashBlock("pnpm test");
    screen.getByRole("button", { name: "在终端运行" }).click();
    expect(runBash).toHaveBeenCalledWith("pnpm test");
  });
});
