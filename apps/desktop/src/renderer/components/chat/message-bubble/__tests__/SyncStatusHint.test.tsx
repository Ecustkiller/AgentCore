// @vitest-environment jsdom
/**
 * Local-only synced_pending / synced caption on optimistic bubbles.
 * The block comment keeps the @vitest-environment directive file-leading.
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SyncStatusHint } from "../SyncStatusHint";

afterEach(cleanup);

function wrap(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("SyncStatusHint", () => {
  it("renders nothing when syncStatus is absent", () => {
    const { container } = wrap(<SyncStatusHint syncStatus={undefined} />);
    expect(container.childElementCount).toBe(0);
  });

  it("shows 待同步 for synced_pending", () => {
    wrap(<SyncStatusHint syncStatus="synced_pending" />);
    const el = screen.getByTestId("sync-status-synced_pending");
    expect(el.textContent).toContain("待同步");
    expect(screen.getByLabelText("待同步")).toBeTruthy();
  });

  it("shows 已同步 for synced", () => {
    wrap(<SyncStatusHint syncStatus="synced" />);
    const el = screen.getByTestId("sync-status-synced");
    expect(el.textContent).toContain("已同步");
    expect(screen.getByLabelText("已同步")).toBeTruthy();
  });
});
