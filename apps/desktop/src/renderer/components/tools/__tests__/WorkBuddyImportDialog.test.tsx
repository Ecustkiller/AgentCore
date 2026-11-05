// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyImportDialog } from "../WorkBuddyImportDialog";

const { scanWorkBuddyLocal } = vi.hoisted(() => ({
  scanWorkBuddyLocal: vi.fn(),
}));

vi.mock("@/services/workbuddyImport", () => ({
  scanWorkBuddyLocal,
}));

describe("WorkBuddyImportDialog", () => {
  beforeEach(() => {
    scanWorkBuddyLocal.mockResolvedValue({
      ok: true,
      roots: [".workbuddy"],
      warnings: [],
      skills: [
        {
          id: "skill-1",
          name: "Commit Helper",
          description: "分步提交",
          source: "workbuddy",
          folder: "commit-helper",
          skillhub: false,
          resourceCount: 0,
          configKeys: [],
        },
      ],
      mcpServers: [],
    });
  });

  it("imports explicitly selected local skills", async () => {
    const onImport = vi.fn().mockResolvedValue({ failures: [] });
    render(
      <WorkBuddyImportDialog
        open
        busy={false}
        onOpenChange={() => undefined}
        onImport={onImport}
      />,
    );

    const title = await screen.findByText("Commit Helper");
    const checkbox = title
      .closest("label")
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /导入选中（1）/i }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toHaveLength(1);
    expect(onImport.mock.calls[0][0][0].name).toBe("Commit Helper");
  });
});
