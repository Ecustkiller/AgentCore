import {
  buildLedgerMap,
  extractLedgerId,
  ledgerBadgeLabel,
  ledgerDateLabel,
  mergeEvidenceLedger,
} from "@/lib/evidenceLedger";
import type { EvidenceLedgerEntry } from "@/types/events";
import { describe, expect, it } from "vitest";

const entry = (
  partial: Partial<EvidenceLedgerEntry> & { id: string },
): EvidenceLedgerEntry => ({
  id: partial.id,
  url: partial.url ?? "",
  title: partial.title ?? "",
  snippet: partial.snippet ?? "",
  site: partial.site ?? "",
  date: partial.date ?? "",
  tier: partial.tier ?? "unknown",
  side_key: partial.side_key ?? "",
});

describe("extractLedgerId", () => {
  it("extracts pure #rN", () => {
    expect(extractLedgerId("#r3")).toBe("#r3");
  });

  it("extracts #rN from dual-write note", () => {
    expect(extractLedgerId("街访数据 #r3")).toBe("#r3");
  });

  it("returns null for free-text legacy notes", () => {
    expect(extractLedgerId("2024年报")).toBeNull();
  });
});

describe("mergeEvidenceLedger", () => {
  it("appends new ids and overwrites same id", () => {
    const a = entry({ id: "#r1", site: "a.gov.cn" });
    const b = entry({ id: "#r2", site: "b.com" });
    const b2 = entry({ id: "#r2", site: "b2.com", title: "updated" });
    expect(mergeEvidenceLedger([a], [b, b2])).toEqual([a, b2]);
  });
});

describe("ledger display helpers", () => {
  it("prefers site then title then id", () => {
    expect(ledgerBadgeLabel(entry({ id: "#r1", site: "court.gov.cn" }))).toBe(
      "court.gov.cn",
    );
    expect(ledgerBadgeLabel(entry({ id: "#r1", title: "判决书" }))).toBe(
      "判决书",
    );
    expect(ledgerBadgeLabel(entry({ id: "#r1" }))).toBe("#r1");
  });

  it("maps empty date", () => {
    expect(ledgerDateLabel("")).toBe("日期未知");
    expect(ledgerDateLabel("2024-01-01")).toBe("2024-01-01");
  });

  it("buildLedgerMap keys by id", () => {
    const m = buildLedgerMap([entry({ id: "#r1" }), entry({ id: "#r2" })]);
    expect(m.get("#r1")?.id).toBe("#r1");
    expect(m.get("#r9")).toBeUndefined();
  });
});
