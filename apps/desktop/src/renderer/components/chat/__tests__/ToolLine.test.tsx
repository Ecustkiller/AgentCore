// @vitest-environment jsdom
/**
 * Render test for ToolLine 结果卡自动展开 (联网前端展示优化): tools whose output IS the payload
 * the user was waiting on — web_search's hits and code_execute's terminal output — auto-open
 * their result card once on the running→done edge, while every other tool stays collapsed by
 * default. The block comment detaches the @vitest-environment directive from the import block
 * so organizeImports keeps it file-leading.
 */

import type { ProcessStep } from "@/types/events";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolLine } from "../ToolLine";

afterEach(cleanup);

type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

function step(over: Partial<ToolStep>): ToolStep {
  return {
    kind: "tool",
    id: "call_1",
    tool_name: "code_execute",
    arguments: {},
    result: null,
    display: null,
    status: "success",
    ...over,
  };
}

describe("ToolLine · 结果卡自动展开", () => {
  it("auto-expands code_execute's terminal on the running→done edge", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "code_execute",
          arguments: { code: "print('hi')", language: "python" },
          status: "running",
        })}
      />,
    );
    // Running: nothing to expand yet — the terminal (退出码 badge) is absent.
    expect(screen.queryByText(/退出码 0/)).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "code_execute",
          arguments: { code: "print('hi')", language: "python" },
          result: "stdout:\nhello world",
          display: {
            stdout: "hello world\n",
            stderr: "",
            exit_code: 0,
            language: "python",
          },
          status: "success",
        })}
      />,
    );
    // Done: the terminal auto-opened without a click — its 退出码 0 badge (expanded-only,
    // the collapsed peek reads the stdout line) is now shown.
    expect(screen.getByText(/退出码 0/)).toBeTruthy();
  });

  it("still auto-expands web_search results (regression)", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "web_search",
          arguments: { query: "深圳天气" },
          status: "running",
        })}
      />,
    );
    // The hit title is expanded-only (while running only the query detail shows).
    expect(screen.queryByText("深圳天气预报")).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "web_search",
          arguments: { query: "深圳天气" },
          result: "1 条结果",
          display: {
            query: "深圳天气",
            results: [
              {
                title: "深圳天气预报",
                url: "https://w.example.com",
                site: "w.example.com",
                snippet: "多云转晴",
              },
            ],
          },
          status: "success",
        })}
      />,
    );
    // Expanded: the result card's title is visible (the collapsed peek reads「1 条结果」only).
    expect(screen.getByText("深圳天气预报")).toBeTruthy();
  });

  it("auto-expands str_replace diff on the running→done edge", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "str_replace",
          arguments: {
            path: "src/foo.ts",
            old_string: "const x = 1",
            new_string: "const x = 2",
          },
          status: "running",
        })}
      />,
    );
    // Collapsed peek only — the diff's +/- counts are expanded-only.
    expect(screen.queryByText("+1")).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "str_replace",
          arguments: {
            path: "src/foo.ts",
            old_string: "const x = 1",
            new_string: "const x = 2",
          },
          result: "已编辑 src/foo.ts",
          status: "success",
        })}
      />,
    );
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("auto-expands file_write content card on the running→done edge", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "file_write",
          arguments: { path: "src/new.ts", content: "export const x = 1" },
          status: "running",
        })}
      />,
    );
    // Line-count footer is expanded-only (collapsed peek reads「已写入 …」).
    expect(screen.queryByText(/1 行 ·/)).toBeNull();

    rerender(
      <ToolLine
        step={step({
          tool_name: "file_write",
          arguments: { path: "src/new.ts", content: "export const x = 1" },
          result: "已写入 src/new.ts",
          status: "success",
        })}
      />,
    );
    expect(screen.getByText(/1 行 ·/)).toBeTruthy();
  });

  it("leaves a non-listed tool (consult_memory) collapsed on completion", () => {
    const { rerender } = render(
      <ToolLine
        step={step({
          tool_name: "consult_memory",
          arguments: { topic: "部署流程" },
          status: "running",
        })}
      />,
    );
    rerender(
      <ToolLine
        step={step({
          tool_name: "consult_memory",
          arguments: { topic: "部署流程" },
          result: "用 pnpm dev 起前端",
          display: { topic: "部署流程" },
          status: "success",
        })}
      />,
    );
    // Not in AUTO_EXPAND_ON_DONE → stays collapsed: the consulted note body (expanded-only)
    // never renders; only the collapsed one-line peek is shown.
    expect(screen.queryByText(/用 pnpm dev 起前端/)).toBeNull();
  });
});
