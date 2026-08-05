import { describe, expect, it } from "vitest";
import { formatFileMtime, formatFileSize } from "../FileBrowser";

describe("formatFileSize", () => {
  it("formats B / KB / MB", () => {
    expect(formatFileSize(12)).toBe("12 B");
    expect(formatFileSize(5 * 1024)).toBe("5.0 KB");
    expect(formatFileSize(12_000)).toBe("12 KB");
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});

describe("formatFileMtime", () => {
  const now = Date.parse("2026-08-05T12:00:00.000Z");

  it("uses short Chinese relative labels", () => {
    expect(formatFileMtime(now - 30_000, now)).toBe("刚刚");
    expect(formatFileMtime(now - 15 * 60_000, now)).toBe("15 分钟前");
    expect(formatFileMtime(now - 3 * 3600_000, now)).toBe("3 小时前");
  });

  it("labels calendar yesterday as 昨天", () => {
    // Local calendar day before `now` — construct via Date parts so TZ is stable.
    const d = new Date(now);
    const y = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() - 1,
      15,
      0,
      0,
    );
    expect(formatFileMtime(y.getTime(), now)).toBe("昨天");
  });
});
