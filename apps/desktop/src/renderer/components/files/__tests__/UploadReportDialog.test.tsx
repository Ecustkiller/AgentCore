// @vitest-environment jsdom

import { UploadReportDialog } from "@/components/files/UploadReportDialog";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("UploadReportDialog failure reason tone", () => {
  it("lists each failure reason in muted, not destructive", () => {
    render(
      <UploadReportDialog
        report={{
          destDir: "",
          uploaded: 0,
          ignored: [],
          truncated: false,
          failures: [{ path: "big.bin", reason: "超过大小限制" }],
        }}
        onClose={() => {}}
      />,
    );
    const reason = screen.getByText("超过大小限制");
    expect(reason.className).toContain("text-muted-foreground");
    expect(reason.className).not.toContain("destructive");
  });
});
