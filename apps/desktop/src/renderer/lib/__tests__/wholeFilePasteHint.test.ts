import type { ProcessStep } from "@/types/events";
import { describe, expect, it } from "vitest";
import {
  collectSuccessfulFileWrites,
  formatWholeFilePasteHint,
  looksLikeWholeFilePasteHandoff,
  shouldShowWholeFilePasteHint,
} from "../wholeFilePasteHint";

function toolStep(
  tool_name: string,
  status: "running" | "success" | "error",
  args: Record<string, unknown> = {},
  id = tool_name,
): Extract<ProcessStep, { kind: "tool" }> {
  return {
    kind: "tool",
    id,
    tool_name,
    arguments: args,
    result: status === "error" ? "failed" : null,
    status,
  };
}

describe("collectSuccessfulFileWrites", () => {
  it("collects successful file ops from process", () => {
    const arts = collectSuccessfulFileWrites([
      toolStep("file_write", "success", { path: "a.ts", content: "x" }),
      toolStep("host_shell", "success"),
      toolStep("str_replace", "error", {
        path: "b.ts",
        old_string: "a",
        new_string: "b",
      }),
    ]);
    expect(arts.map((a) => a.path)).toEqual(["a.ts"]);
  });

  it("returns empty when no successful file writes", () => {
    expect(
      collectSuccessfulFileWrites([
        toolStep("file_write", "error", { path: "a.ts", content: "x" }),
        toolStep("web_search", "success"),
      ]),
    ).toEqual([]);
    expect(collectSuccessfulFileWrites(undefined)).toEqual([]);
  });

  it("merges journal.runProcesses writes (multi-agent)", () => {
    const arts = collectSuccessfulFileWrites(
      [toolStep("web_search", "success")],
      {
        events: [],
        finishReason: "end_turn",
        runProcesses: {
          worker_a: [
            toolStep("file_write", "success", {
              path: "src/w.ts",
              content: "ok",
            }),
          ],
        },
      },
    );
    expect(arts.map((a) => a.path)).toEqual(["src/w.ts"]);
  });

  it("does not treat failed process write as success even if journal empty", () => {
    expect(
      collectSuccessfulFileWrites([
        toolStep("file_write", "error", { path: "a.ts", content: "x" }),
      ]),
    ).toEqual([]);
  });
});

describe("looksLikeWholeFilePasteHandoff", () => {
  it("matches strong handoff phrasing", () => {
    expect(looksLikeWholeFilePasteHandoff("请直接替换整个文件内容即可。")).toBe(
      true,
    );
    expect(
      looksLikeWholeFilePasteHandoff(
        "请你打开该文件并替换整个文件为下面内容。",
      ),
    ).toBe(true);
    expect(looksLikeWholeFilePasteHandoff("可整文件自行粘贴到编辑器。")).toBe(
      true,
    );
    expect(looksLikeWholeFilePasteHandoff("把整个文件内容替换成如下。")).toBe(
      true,
    );
  });

  it("misses ordinary paste teaching / partial edit talk", () => {
    expect(
      looksLikeWholeFilePasteHandoff(
        "把下面这段代码粘贴到 `main` 函数里即可。",
      ),
    ).toBe(false);
    expect(
      looksLikeWholeFilePasteHandoff("我已用 str_replace 改了相关片段。"),
    ).toBe(false);
    expect(looksLikeWholeFilePasteHandoff("")).toBe(false);
    expect(looksLikeWholeFilePasteHandoff(undefined)).toBe(false);
  });
});

describe("shouldShowWholeFilePasteHint", () => {
  it("shows when no writes + handoff body", () => {
    expect(
      shouldShowWholeFilePasteHint({
        content: "请直接替换整个文件。",
        hasSuccessfulWrites: false,
      }),
    ).toBe(true);
  });

  it("hides when writes succeeded", () => {
    expect(
      shouldShowWholeFilePasteHint({
        content: "请直接替换整个文件。",
        hasSuccessfulWrites: true,
      }),
    ).toBe(false);
  });

  it("hides when empty content", () => {
    expect(
      shouldShowWholeFilePasteHint({
        content: "   ",
        hasSuccessfulWrites: false,
      }),
    ).toBe(false);
  });

  it("hides when body is not handoff phrasing", () => {
    expect(
      shouldShowWholeFilePasteHint({
        content: "已改好菜单。",
        hasSuccessfulWrites: false,
      }),
    ).toBe(false);
  });
});

describe("formatWholeFilePasteHint", () => {
  it("returns short ignorable copy", () => {
    expect(formatWholeFilePasteHint()).toBe(
      "本轮未写入工作区；聊天整文件≠代改",
    );
  });
});
