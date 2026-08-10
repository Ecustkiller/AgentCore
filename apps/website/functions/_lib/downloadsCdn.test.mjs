/**
 * Path / channel helpers for desktop CDN dual-track (§7.6c).
 * Run: node --test apps/website/functions/_lib/downloadsCdn.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESKTOP_CHANNEL_DEFAULT,
  DOWNLOADS_DESKTOP_PREFIX,
  desktopChannelPrefix,
  desktopFeedUrl,
  desktopLatestJsonUrl,
  desktopLegacyFlatPrefix,
  desktopSyncDestPrefixes,
  normalizeDesktopChannel,
} from "./downloadsCdn.mjs";

describe("normalizeDesktopChannel", () => {
  it("defaults empty to stable", () => {
    assert.equal(normalizeDesktopChannel(""), "stable");
    assert.equal(normalizeDesktopChannel("STABLE"), "stable");
    assert.equal(DESKTOP_CHANNEL_DEFAULT, "stable");
  });

  it("accepts beta", () => {
    assert.equal(normalizeDesktopChannel("beta"), "beta");
    assert.equal(normalizeDesktopChannel("Beta"), "beta");
  });

  it("rejects unknown", () => {
    assert.throws(() => normalizeDesktopChannel("canary"), /Invalid desktop channel/);
  });
});

describe("desktop path prefixes", () => {
  it("channel dirs are desktop/{stable|beta}", () => {
    assert.equal(desktopChannelPrefix("stable"), "desktop/stable");
    assert.equal(desktopChannelPrefix("beta"), "desktop/beta");
    assert.equal(desktopLegacyFlatPrefix(), DOWNLOADS_DESKTOP_PREFIX);
    assert.equal(desktopLegacyFlatPrefix(), "desktop");
  });

  it("stable sync mirrors flat desktop/", () => {
    assert.deepEqual(desktopSyncDestPrefixes("stable"), [
      "desktop/stable",
      "desktop",
    ]);
    assert.deepEqual(desktopSyncDestPrefixes(), ["desktop/stable", "desktop"]);
  });

  it("beta sync writes only desktop/beta (never flat or stable)", () => {
    const dests = desktopSyncDestPrefixes("beta");
    assert.deepEqual(dests, ["desktop/beta"]);
    assert.ok(!dests.includes("desktop"));
    assert.ok(!dests.includes("desktop/stable"));
  });

  it("latest.json / feed URLs include channel segment", () => {
    assert.match(desktopLatestJsonUrl("stable"), /\/desktop\/stable\/latest\.json$/);
    assert.match(desktopLatestJsonUrl("beta"), /\/desktop\/beta\/latest\.json$/);
    assert.match(desktopFeedUrl("stable"), /\/desktop\/stable$/);
    assert.match(desktopFeedUrl("beta"), /\/desktop\/beta$/);
  });
});
