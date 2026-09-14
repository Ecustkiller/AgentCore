// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SponsorSettings } from "../SponsorSettings";

afterEach(cleanup);

describe("SponsorSettings", () => {
  it("does not ship payment QR images", () => {
    render(<SponsorSettings />);
    expect(screen.getByRole("heading", { name: "赞助" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/不随公开仓库分发/)).toBeTruthy();
  });
});
