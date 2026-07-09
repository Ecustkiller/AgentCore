// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileSource } from "@/lib/fileSource";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { useConversationStore } from "@/stores/conversation";
import { ClientToolsPrompt } from "../ClientToolsPrompt";

vi.mock("@/hooks/useConversationFileSource", () => ({
  useConversationFileSource: vi.fn(),
}));

vi.mock("@/lib/capabilities", () => ({
  hasTerminalRun: vi.fn(() => true),
}));

import { useConversationFileSource } from "@/hooks/useConversationFileSource";
import { hasTerminalRun } from "@/lib/capabilities";

const useSourceMock = vi.mocked(useConversationFileSource);
const hasTerminalRunMock = vi.mocked(hasTerminalRun);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function mockSource(
  over: Partial<FileSource> & Pick<FileSource, "id" | "label" | "caps">,
): FileSource {
  return {
    listDir: vi.fn(),
    read: vi.fn(),
    createFile: vi.fn(),
    mkdir: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    ...over,
  };
}

function renderPrompt() {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ClientToolsPrompt />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const baseMsg = {
  createdAt: "",
  executionId: null,
  isStreaming: false,
};

beforeEach(() => {
  queryClient.clear();
  hasTerminalRunMock.mockReturnValue(true);
  window.terminalApi = { runBash: vi.fn(async () => ({ ok: true })) };
  useConversationStore.setState({
    currentConversationId: "c1",
    byId: {
      c1: {
        ...EMPTY_RUNTIME,
        isGenerating: false,
        messages: [
          {
            ...baseMsg,
            id: "u1",
            role: "user",
            content: "请运行这个项目",
          },
          {
            ...baseMsg,
            id: "a1",
            role: "assistant",
            content: [
              "执行：",
              "```bash",
              "pnpm dev",
              "```",
            ].join("\n"),
          },
        ],
      },
    },
  });
});

afterEach(() => {
  cleanup();
  delete window.terminalApi;
  useSourceMock.mockReset();
});

describe("ClientToolsPrompt", () => {
  it("shows local client tool actions when source has client methods and user hinted execution", async () => {
    const reveal = vi.fn().mockResolvedValue(undefined);
    const openShell = vi.fn().mockResolvedValue(undefined);
    useSourceMock.mockReturnValue(
      mockSource({
        id: "local:r1",
        label: "本地",
        caps: { watch: true, transfer: false, edit: true, snapshots: false },
        revealInOsFileManager: reveal,
        openShellAtPath: openShell,
      }),
    );

    renderPrompt();

    expect(screen.getByText("本机快捷操作")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    fireEvent.click(screen.getByRole("button", { name: "打开终端" }));
    fireEvent.click(screen.getByRole("button", { name: /运行 pnpm dev/ }));
    expect(reveal).toHaveBeenCalledWith("");
    expect(openShell).toHaveBeenCalledWith(".");
    await waitFor(() => {
      expect(window.terminalApi?.runBash).toHaveBeenCalledWith("pnpm dev");
    });
  });

  it("renders nothing for cloud source without client tool methods", () => {
    useSourceMock.mockReturnValue(
      mockSource({
        id: "cloud:1",
        label: "云端",
        caps: { watch: false, transfer: true, edit: true, snapshots: true },
      }),
    );

    const { container } = renderPrompt();
    expect(container.firstChild).toBeNull();
  });
});
