// @vitest-environment jsdom

import { CloneRepoDialog } from "@/components/files/CloneRepoDialog";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

describe("CloneRepoDialog submit failure tone", () => {
  it("validation failure is muted, not destructive", () => {
    render(
      <MemoryRouter>
        <CloneRepoDialog open onOpenChange={() => {}} wsId="folder:1" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "克隆" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("请填写仓库地址");
    expect(alert.className).toContain("text-muted-foreground");
    expect(alert.className).not.toContain("destructive");
  });
});
