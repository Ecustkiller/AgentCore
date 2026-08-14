// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentChip } from "../AttachmentChip";

const downloadWorkspaceFile = vi.fn();
vi.mock("@/services/workspace", () => ({
  downloadWorkspaceFile: (...args: unknown[]) => downloadWorkspaceFile(...args),
}));

afterEach(() => {
  cleanup();
  downloadWorkspaceFile.mockReset();
});

describe("AttachmentChip download failure", () => {
  it("marks a recoverable download miss as muted, not destructive", async () => {
    downloadWorkspaceFile.mockRejectedValueOnce(new Error("network"));
    render(
      <TooltipProvider>
        <AttachmentChip
          att={{
            id: "a1",
            name: "shot.png",
            path: "shot.png",
            truncated: false,
            kind: "file",
            workspacePath: "attachments/shot.png",
          }}
          conversationId="c1"
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      const btn = screen.getByRole("button");
      expect(btn.className).toContain("text-muted-foreground");
      expect(btn.className).not.toContain("destructive");
    });
  });
});
