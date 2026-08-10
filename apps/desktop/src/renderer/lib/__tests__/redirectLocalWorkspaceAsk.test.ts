import {
  isRedirectedLocalWorkspaceAskAction,
  redirectLocalWorkspaceAskAction,
} from "@/lib/redirectLocalWorkspaceAsk";
import { notifyError } from "@/lib/toast";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

describe("redirectLocalWorkspaceAsk (retired)", () => {
  it("no longer treats the three ask actions as redirected", () => {
    expect(isRedirectedLocalWorkspaceAskAction("open_local_project")).toBe(
      false,
    );
    expect(isRedirectedLocalWorkspaceAskAction("register_local_project")).toBe(
      false,
    );
    expect(isRedirectedLocalWorkspaceAskAction("bind_local_folder")).toBe(
      false,
    );
  });

  it("is a no-op — no Composer import / Git toast", () => {
    redirectLocalWorkspaceAskAction();
    expect(notifyError).not.toHaveBeenCalled();
  });
});
