// @vitest-environment jsdom
import { IconButton } from "@/components/ui";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("IconButton tones", () => {
  it("default is ghost chrome, not a filled chip", () => {
    render(<IconButton aria-label="ghost" />);
    const cls = screen.getByRole("button").className;
    expect(cls).not.toContain("bg-muted");
    expect(cls).not.toContain("bg-primary");
    expect(cls).not.toContain("bg-foreground");
  });

  it("muted is a filled tonal chip that stays solid when disabled", () => {
    render(<IconButton aria-label="rest" tone="muted" disabled />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("bg-muted");
    expect(cls).toContain("disabled:opacity-100");
    expect(cls).not.toContain("disabled:opacity-60");
    expect(cls).not.toContain("bg-primary");
  });

  it("primary is brand fill", () => {
    render(<IconButton aria-label="go" tone="primary" />);
    expect(screen.getByRole("button").className).toContain("bg-primary");
  });
});
