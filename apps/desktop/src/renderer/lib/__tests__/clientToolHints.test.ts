// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  deriveClientToolsHint,
  extractLastBashBlock,
  hasExecutionIntent,
} from "@/lib/clientToolHints";
import type { FileSource } from "@/lib/fileSource";
import type { Message } from "@/stores/conversation/types";
import { vi } from "vitest";

function mockLocalSource(): FileSource {
  return {
    id: "local:r1",
    label: "本地",
    caps: { watch: true, transfer: false, edit: true, snapshots: false },
    listDir: vi.fn(),
    read: vi.fn(),
    createFile: vi.fn(),
    mkdir: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    revealInOsFileManager: vi.fn(),
    openShellAtPath: vi.fn(),
  };
}

function mockCloudSource(): FileSource {
  return {
    id: "cloud:1",
    label: "云端",
    caps: { watch: false, transfer: true, edit: true, snapshots: true },
    listDir: vi.fn(),
    read: vi.fn(),
    createFile: vi.fn(),
    mkdir: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
  };
}

const baseMsg = {
  createdAt: "",
  executionId: null,
  isStreaming: false,
} satisfies Partial<Message>;

describe("clientToolHints", () => {
  it("detects execution intent aligned with server hints", () => {
    expect(hasExecutionIntent("请运行这个项目")).toBe(true);
    expect(hasExecutionIntent("open the app")).toBe(false);
    expect(hasExecutionIntent("pnpm run dev")).toBe(true);
  });

  it("extracts the last bash/sh fenced block", () => {
    const content = [
      "```sh",
      "echo first",
      "```",
      "text",
      "```bash",
      "npm start",
      "```",
    ].join("\n");
    expect(extractLastBashBlock(content)).toBe("npm start");
  });

  it("returns a hint for local source + execution intent + finished turn", () => {
    const messages: Message[] = [
      {
        ...baseMsg,
        id: "u1",
        role: "user",
        content: "帮我安装依赖并跑通",
      },
      {
        ...baseMsg,
        id: "a1",
        role: "assistant",
        content: "好的",
      },
    ];
    expect(
      deriveClientToolsHint(messages, mockLocalSource(), false),
    ).toEqual({ bashCommand: null });
  });

  it("returns null for cloud source without client tool methods", () => {
    const messages: Message[] = [
      {
        ...baseMsg,
        id: "u1",
        role: "user",
        content: "请运行测试",
      },
      {
        ...baseMsg,
        id: "a1",
        role: "assistant",
        content: "完成",
      },
    ];
    expect(deriveClientToolsHint(messages, mockCloudSource(), false)).toBeNull();
  });
});
