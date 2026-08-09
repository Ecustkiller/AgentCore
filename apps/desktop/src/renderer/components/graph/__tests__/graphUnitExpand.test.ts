import { describe, expect, it } from "vitest";
import {
  GRAPH_UNIT_EXPAND_TOUCHED,
  resolveGraphExpandedUnits,
} from "../graphUnitExpand";

describe("resolveGraphExpandedUnits", () => {
  const defaults = new Set(["lead", "mpm"]);

  it("defaults to expand all foldable units before any user toggle", () => {
    expect([
      ...resolveGraphExpandedUnits({
        defaults,
        touched: false,
        storedFingerprint: "",
        sessionOverride: null,
        persist: true,
      }),
    ]).toEqual(["lead", "mpm"]);
  });

  it("after touch, empty fingerprint means user collapsed all", () => {
    expect([
      ...resolveGraphExpandedUnits({
        defaults,
        touched: true,
        storedFingerprint: "",
        sessionOverride: null,
        persist: true,
      }),
    ]).toEqual([]);
  });

  it("after touch, fingerprint drives expanded set", () => {
    expect([
      ...resolveGraphExpandedUnits({
        defaults,
        touched: true,
        storedFingerprint: "lead",
        sessionOverride: null,
        persist: true,
      }),
    ]).toEqual(["lead"]);
  });

  it("session override wins when not persisting; null falls back to defaults", () => {
    expect([
      ...resolveGraphExpandedUnits({
        defaults,
        touched: false,
        storedFingerprint: "",
        sessionOverride: new Set(["lead"]),
        persist: false,
      }),
    ]).toEqual(["lead"]);
    expect([
      ...resolveGraphExpandedUnits({
        defaults,
        touched: false,
        storedFingerprint: "",
        sessionOverride: null,
        persist: false,
      }),
    ]).toEqual(["lead", "mpm"]);
  });

  it("ignores touched sentinel id if it leaks into fingerprint", () => {
    expect([
      ...resolveGraphExpandedUnits({
        defaults,
        touched: true,
        storedFingerprint: `lead,${GRAPH_UNIT_EXPAND_TOUCHED}`,
        sessionOverride: null,
        persist: true,
      }),
    ]).toEqual(["lead"]);
  });
});
