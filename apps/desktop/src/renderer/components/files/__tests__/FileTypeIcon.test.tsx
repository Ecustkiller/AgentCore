// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DirTypeIcon,
  FileTypeIcon,
  resolveMaterialFileIconName,
} from "../FileTypeIcon";

describe("resolveMaterialFileIconName", () => {
  it("matches well-known file names", () => {
    expect(resolveMaterialFileIconName("package.json")).not.toBe("file");
    expect(resolveMaterialFileIconName(".gitignore")).not.toBe("file");
  });

  it("matches by extension after lowercase", () => {
    expect(resolveMaterialFileIconName("Foo.TS")).not.toBe("file");
    expect(resolveMaterialFileIconName("apps/x/Button.tsx")).not.toBe("file");
    expect(resolveMaterialFileIconName("README.md")).not.toBe("file");
    expect(resolveMaterialFileIconName("script.py")).not.toBe("file");
  });

  it("prefers compound extensions when available", () => {
    const dTs = resolveMaterialFileIconName("types.d.ts");
    const plainTs = resolveMaterialFileIconName("types.ts");
    expect(dTs).not.toBe("file");
    expect(plainTs).not.toBe("file");
    // d.ts 应落到 typescript-def（或至少与普通 ts 区分，若表有专用项）
    expect(dTs).not.toBe(plainTs);
  });

  it("handles Dockerfile / LICENSE case", () => {
    expect(resolveMaterialFileIconName("Dockerfile")).not.toBe("file");
    expect(resolveMaterialFileIconName("LICENSE")).not.toBe("file");
  });

  it("falls back for unknown", () => {
    expect(resolveMaterialFileIconName("weird.nopezz")).toBe("file");
  });
});

describe("FileTypeIcon", () => {
  it("renders without crashing for common names", () => {
    const { container } = render(
      <FileTypeIcon name="package.json" size={13} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it("accepts path and uses basename", () => {
    const { container } = render(
      <FileTypeIcon path="apps/desktop/README.md" size={14} />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

describe("DirTypeIcon", () => {
  it("renders folder icon", () => {
    const { container } = render(<DirTypeIcon name="src" isOpen size={13} />);
    expect(container.firstChild).toBeTruthy();
  });
});
