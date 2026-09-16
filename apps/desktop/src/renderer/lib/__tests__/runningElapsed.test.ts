import {
  MAX_SANE_RUNNING_ELAPSED_SEC,
  completedAtIso,
  runningElapsedSec,
  startedAtFromIso,
} from "@/lib/runningElapsed";
import { describe, expect, it } from "vitest";

describe("runningElapsedSec", () => {
  it("returns floor seconds for recent starts", () => {
    const now = 1_700_000_000_000;
    expect(runningElapsedSec(now - 45_000, now)).toBe(45);
  });

  it("clamps absurd offline-preview skew to 0 (omit Ns suffix)", () => {
    const now = 1_700_000_000_000;
    const started = now - (MAX_SANE_RUNNING_ELAPSED_SEC + 1) * 1000;
    expect(runningElapsedSec(started, now)).toBe(0);
  });

  it("returns 0 for null / NaN", () => {
    expect(runningElapsedSec(null)).toBe(0);
    expect(runningElapsedSec(Number.NaN)).toBe(0);
  });
});

describe("startedAtFromIso", () => {
  it("parses a valid ISO timestamp", () => {
    expect(startedAtFromIso("2026-01-01T00:00:00.000Z")).toBe(
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
  });

  it("returns null for empty / garbage", () => {
    expect(startedAtFromIso("")).toBeNull();
    expect(startedAtFromIso(null)).toBeNull();
    expect(startedAtFromIso("nope")).toBeNull();
  });
});

describe("completedAtIso", () => {
  it("adds whole-turn duration onto the start clock", () => {
    expect(completedAtIso("2026-01-01T00:00:00.000Z", 90_000)).toBe(
      "2026-01-01T00:01:30.000Z",
    );
  });

  it("keeps the start clock when duration is missing or non-positive", () => {
    expect(completedAtIso("2026-01-01T00:00:00.000Z")).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(completedAtIso("2026-01-01T00:00:00.000Z", 0)).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(completedAtIso("2026-01-01T00:00:00.000Z", null)).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
});
