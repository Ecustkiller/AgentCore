import { formatCompact, formatCost, formatUsd } from "@/lib/format";
import { describe, expect, it } from "vitest";

// 1 USD = 1e9 nano-USD (ledger canonical unit).
const USD = 1_000_000_000;

describe("formatCost", () => {
  it("converts nano-USD to CNY via the rate, rounded to fen", () => {
    // 0.0166667 USD × 7.2 ≈ ¥0.12
    expect(formatCost(16_666_667, 7.2)).toBe("¥0.12");
    expect(formatCost(USD, 7.2)).toBe("¥7.20");
  });

  it("shows「—」for zero / negative (无花销，不显 ¥0.00) — §7.5", () => {
    expect(formatCost(0, 7.2)).toBe("—");
    expect(formatCost(-5, 7.2)).toBe("—");
  });

  it("shows「<¥0.01」for a cost that rounds below one fen", () => {
    // 1000 nano = 1e-6 USD × 7.2 = 7.2e-6 元 < 0.01
    expect(formatCost(1000, 7.2)).toBe("<¥0.01");
  });

  it("tracks the rate (单一来源，前端不写死)", () => {
    // Same nano amount, a different FX rate → a different yuan figure.
    expect(formatCost(USD, 10)).toBe("¥10.00");
  });
});

describe("formatUsd", () => {
  it("formats nano-USD as $ with 4 decimals (power 面)", () => {
    expect(formatUsd(12_300_000)).toBe("$0.0123");
    expect(formatUsd(USD)).toBe("$1.0000");
  });

  it("shows「—」for zero / negative — §7.5", () => {
    expect(formatUsd(0)).toBe("—");
    expect(formatUsd(-1)).toBe("—");
  });

  it("shows「<$0.0001」for a positive cost below the display floor", () => {
    // 1000 nano = 1e-6 USD < 0.0001
    expect(formatUsd(1000)).toBe("<$0.0001");
  });
});

describe("formatCompact", () => {
  it("keeps small counts verbatim, abbreviates k then M (用量大数)", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(820)).toBe("820");
    expect(formatCompact(8200)).toBe("8.2k");
    expect(formatCompact(820_000)).toBe("820.0k");
    expect(formatCompact(2_000_000)).toBe("2.0M");
  });
});
