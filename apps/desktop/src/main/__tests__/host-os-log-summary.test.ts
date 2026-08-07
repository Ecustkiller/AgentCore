import { describe, expect, it } from "vitest";
import { runHostOp } from "../host/dispatch";
import {
  OS_LOG_BYTES_DEFAULT,
  OS_LOG_BYTES_MAX,
  OS_LOG_ENTRIES_DEFAULT,
  OS_LOG_ENTRIES_MAX,
  OS_LOG_MINUTES_DEFAULT,
  OS_LOG_MINUTES_MAX,
  normalizeOsLogArgs,
  redactOsLogText,
} from "../host/logs";

describe("host_os_log_summary helpers", () => {
  it("redacts token/key shapes but keeps paths", () => {
    const pathKept = "C:\\Users\\ada\\AppData\\Local\\app\\error.log";
    expect(redactOsLogText(pathKept)).toBe(pathKept);
    expect(redactOsLogText("Authorization: Bearer abcdefghijklmnop")).toContain(
      "[REDACTED]",
    );
    expect(redactOsLogText("api_key=sk-abcdefghijklmnopqrst")).toContain(
      "[REDACTED]",
    );
    expect(redactOsLogText("password=hunter2secret")).toContain("[REDACTED]");
  });

  it("clamps minutes / entries / bytes", () => {
    expect(normalizeOsLogArgs({})).toMatchObject({
      level: "warning",
      minutes: OS_LOG_MINUTES_DEFAULT,
      maxEntries: OS_LOG_ENTRIES_DEFAULT,
      maxBytes: OS_LOG_BYTES_DEFAULT,
    });
    expect(
      normalizeOsLogArgs({
        minutes: 99999,
        max_entries: 999,
        max_bytes: 9_999_999,
        level: "nope",
      }),
    ).toMatchObject({
      minutes: OS_LOG_MINUTES_MAX,
      maxEntries: OS_LOG_ENTRIES_MAX,
      maxBytes: OS_LOG_BYTES_MAX,
      level: "warning",
    });
    expect(
      normalizeOsLogArgs({ minutes: 0, max_entries: 0, max_bytes: 10 }),
    ).toMatchObject({
      minutes: 1,
      maxEntries: 1,
      maxBytes: 1024,
    });
  });
});

describe("host_os_log_summary op", () => {
  it("returns bounded envelope (or honest probe error)", async () => {
    const result = await runHostOp({
      op: "host_os_log_summary",
      args: { minutes: 15, max_entries: 5, level: "error" },
    });
    if (!result.ok) {
      expect(result.error.kind).toMatch(/HostOsLog|HostOp/);
      return;
    }
    expect(result.value.bounded).toBe(true);
    expect(result.value.note).toMatch(/os_event_log_bounded_summary/);
    expect(Array.isArray(result.value.entries)).toBe(true);
    expect(Number(result.value.count)).toBeLessThanOrEqual(5);
    if (process.platform === "darwin") {
      expect(result.value.stub).toBe(true);
    }
  });
});
