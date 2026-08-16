import { describe, expect, it } from "vitest";
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectBackoffMs,
} from "../turns/reconnectBackoff";

describe("reconnectBackoffMs", () => {
  it("matches conversationFollow: 1s → 30s, jitter pinned at 0", () => {
    expect(reconnectBackoffMs(0, 0)).toBe(RECONNECT_BASE_MS);
    expect(reconnectBackoffMs(1, 0)).toBe(2_000);
    expect(reconnectBackoffMs(2, 0)).toBe(4_000);
    expect(reconnectBackoffMs(3, 0)).toBe(8_000);
    expect(reconnectBackoffMs(4, 0)).toBe(16_000);
    expect(reconnectBackoffMs(5, 0)).toBe(RECONNECT_MAX_MS);
    expect(reconnectBackoffMs(8, 0)).toBe(RECONNECT_MAX_MS);
  });

  it("adds at most 500ms jitter", () => {
    expect(reconnectBackoffMs(0, 1)).toBe(RECONNECT_BASE_MS + 500);
  });
});
