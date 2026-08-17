/**
 * Keep/delete plan for brand-host release artifacts.
 * Run: node --test deploy/scripts/prune-release-cdn.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEED_KEEP_NAMES,
  androidArtifactNames,
  desktopArtifactNames,
  filenamesFromLatestJson,
  filenamesFromUpdaterYml,
  isAndroidArtifact,
  isDesktopArtifact,
  isSafeBasename,
  keepHintsFromManifests,
  macZipFilename,
  planPrune,
  versionFromArtifactName,
} from "./prune-release-cdn.mjs";

function allDesktopFor(version) {
  return desktopArtifactNames(version);
}

describe("artifact name parsing", () => {
  it("parses stable and pre-release desktop names including blockmaps", () => {
    assert.equal(
      versionFromArtifactName("AgentCore-0.9.4-win-x64.exe"),
      "0.9.4",
    );
    assert.equal(
      versionFromArtifactName("AgentCore-0.9.4-win-x64.exe.blockmap"),
      "0.9.4",
    );
    assert.equal(
      versionFromArtifactName("AgentCore-0.9.4-mac-arm64.dmg"),
      "0.9.4",
    );
    assert.equal(
      versionFromArtifactName("AgentCore-0.9.4-mac-arm64.zip.blockmap"),
      "0.9.4",
    );
    assert.equal(
      versionFromArtifactName("AgentCore-1.2.3-beta.1-win-x64.exe"),
      "1.2.3-beta.1",
    );
    assert.equal(
      versionFromArtifactName("AgentCore-0.9.4-android.apk"),
      "0.9.4",
    );
  });

  it("returns null for feed files and unknown names (must keep)", () => {
    for (const name of FEED_KEEP_NAMES) {
      assert.equal(versionFromArtifactName(name), null);
    }
    assert.equal(versionFromArtifactName("notes.txt"), null);
    assert.equal(versionFromArtifactName("AgentCore-Setup.exe"), null);
    assert.equal(versionFromArtifactName("stable"), null);
    assert.equal(versionFromArtifactName("beta"), null);
  });

  it("kind matchers do not cross rails", () => {
    assert.equal(isDesktopArtifact("AgentCore-0.9.4-android.apk"), false);
    assert.equal(isAndroidArtifact("AgentCore-0.9.4-win-x64.exe"), false);
    assert.equal(isDesktopArtifact("latest.yml"), false);
  });

  it("rejects path-like names", () => {
    assert.equal(isSafeBasename("AgentCore-0.9.4-win-x64.exe"), true);
    assert.equal(isSafeBasename("foo/bar.exe"), false);
    assert.equal(isSafeBasename(".."), false);
    assert.equal(isSafeBasename("latest.yml"), true);
  });
});

describe("manifest parsing", () => {
  it("reads latest.json version + platform filenames", () => {
    const parsed = filenamesFromLatestJson(`{
      "version": "0.9.4",
      "winFilename": "AgentCore-0.9.4-win-x64.exe",
      "macFilename": "AgentCore-0.9.4-mac-arm64.dmg"
    }`);
    assert.equal(parsed.version, "0.9.4");
    assert.deepEqual(parsed.filenames, [
      "AgentCore-0.9.4-win-x64.exe",
      "AgentCore-0.9.4-mac-arm64.dmg",
    ]);
  });

  it("keeps nothing extra when latest.json is garbage", () => {
    assert.deepEqual(filenamesFromLatestJson("not-json"), {
      version: null,
      filenames: [],
    });
  });

  it("reads electron-builder latest.yml path/url + version", () => {
    const yml = [
      "version: 0.9.4",
      "files:",
      "  - url: AgentCore-0.9.4-win-x64.exe",
      "    sha512: abc",
      "path: AgentCore-0.9.4-win-x64.exe",
      "sha512: abc",
    ].join("\n");
    const parsed = filenamesFromUpdaterYml(yml);
    assert.equal(parsed.version, "0.9.4");
    assert.deepEqual(parsed.filenames, [
      "AgentCore-0.9.4-win-x64.exe",
      "AgentCore-0.9.4-win-x64.exe",
    ]);
  });

  it("unions hints from json + both yml files", () => {
    const hints = keepHintsFromManifests({
      latestJson: JSON.stringify({
        version: "0.9.5",
        winFilename: "AgentCore-0.9.5-win-x64.exe",
        macFilename: "AgentCore-0.9.4-mac-arm64.dmg",
      }),
      latestYml: "version: 0.9.5\npath: AgentCore-0.9.5-win-x64.exe\n",
      latestMacYml: "version: 0.9.4\npath: AgentCore-0.9.4-mac-arm64.zip\n",
    });
    assert.ok(hints.extraVersions.includes("0.9.5"));
    assert.ok(hints.extraVersions.includes("0.9.4"));
    assert.ok(
      hints.extraFilenames.includes("AgentCore-0.9.4-mac-arm64.zip"),
    );
  });
});

describe("planPrune desktop", () => {
  it("0.9.4 full-sync: keep current set + feeds; delete older versions", () => {
    const current = "0.9.4";
    const older = ["0.6.9", "0.8.0", "0.9.3"];
    const listed = [
      ...FEED_KEEP_NAMES,
      ...allDesktopFor(current),
      ...older.flatMap(allDesktopFor),
      "notes.txt",
      "stable",
      "beta",
    ];
    const plan = planPrune({
      listedNames: listed,
      kind: "desktop",
      currentVersion: current,
      extraVersions: [current],
      extraFilenames: [
        "AgentCore-0.9.4-win-x64.exe",
        "AgentCore-0.9.4-mac-arm64.dmg",
      ],
    });
    assert.equal(plan.skipped, undefined);
    assert.ok(plan.keepVersions.includes("0.9.4"));
    for (const name of FEED_KEEP_NAMES) {
      assert.ok(plan.keep.includes(name), `must keep ${name}`);
      assert.ok(!plan.delete.includes(name));
    }
    for (const name of allDesktopFor(current)) {
      assert.ok(plan.keep.includes(name), `must keep current ${name}`);
      assert.ok(!plan.delete.includes(name));
    }
    for (const name of older.flatMap(allDesktopFor)) {
      assert.ok(plan.delete.includes(name), `must delete ${name}`);
    }
    assert.ok(plan.keep.includes("notes.txt"));
    assert.ok(plan.keep.includes("stable"));
    assert.ok(plan.keep.includes("beta"));
    assert.equal(plan.delete.length, older.length * 6);
  });

  it("never deletes feed files even if currentVersion is empty (refuse)", () => {
    const listed = ["latest.yml", "AgentCore-0.8.0-win-x64.exe"];
    const plan = planPrune({
      listedNames: listed,
      kind: "desktop",
      currentVersion: "",
    });
    assert.equal(plan.skipped, "no currentVersion");
    assert.deepEqual(plan.delete, []);
    assert.deepEqual(plan.keep, listed);
  });

  it("win-only bump: manifests still name 0.9.4 mac → keep both versions", () => {
    const listed = [
      ...FEED_KEEP_NAMES,
      ...allDesktopFor("0.9.5"),
      ...allDesktopFor("0.9.4"),
      ...allDesktopFor("0.9.3"),
    ];
    const hints = keepHintsFromManifests({
      latestJson: JSON.stringify({
        version: "0.9.5",
        winFilename: "AgentCore-0.9.5-win-x64.exe",
        macFilename: "AgentCore-0.9.4-mac-arm64.dmg",
      }),
      latestYml: "version: 0.9.5\npath: AgentCore-0.9.5-win-x64.exe\n",
      latestMacYml: "version: 0.9.4\npath: AgentCore-0.9.4-mac-arm64.zip\n",
    });
    const plan = planPrune({
      listedNames: listed,
      kind: "desktop",
      currentVersion: "0.9.5",
      ...hints,
    });
    for (const name of allDesktopFor("0.9.5")) {
      assert.ok(!plan.delete.includes(name));
    }
    for (const name of allDesktopFor("0.9.4")) {
      assert.ok(!plan.delete.includes(name), `keep 0.9.4 still in feed: ${name}`);
    }
    for (const name of allDesktopFor("0.9.3")) {
      assert.ok(plan.delete.includes(name));
    }
  });

  it("does not delete android apks in a desktop dest (unknown-to-rail)", () => {
    const plan = planPrune({
      listedNames: [
        "AgentCore-0.8.0-android.apk",
        "AgentCore-0.8.0-win-x64.exe",
      ],
      kind: "desktop",
      currentVersion: "0.9.4",
    });
    assert.ok(plan.keep.includes("AgentCore-0.8.0-android.apk"));
    assert.ok(plan.delete.includes("AgentCore-0.8.0-win-x64.exe"));
  });

  it("keeps an unparseable extraFilename exactly, without expanding to other files", () => {
    const plan = planPrune({
      listedNames: [
        "weird-installer.exe",
        "AgentCore-0.8.0-win-x64.exe",
        "latest.yml",
      ],
      kind: "desktop",
      currentVersion: "0.9.4",
      extraFilenames: ["weird-installer.exe"],
    });
    assert.ok(plan.keep.includes("weird-installer.exe"));
    assert.ok(plan.delete.includes("AgentCore-0.8.0-win-x64.exe"));
  });

  it("beta pre-release version is a distinct keep key", () => {
    const plan = planPrune({
      listedNames: [
        ...allDesktopFor("1.2.3-beta.1"),
        ...allDesktopFor("1.2.3"),
      ],
      kind: "desktop",
      currentVersion: "1.2.3-beta.1",
    });
    for (const name of allDesktopFor("1.2.3-beta.1")) {
      assert.ok(!plan.delete.includes(name));
    }
    for (const name of allDesktopFor("1.2.3")) {
      assert.ok(plan.delete.includes(name));
    }
  });
});

describe("planPrune android", () => {
  it("keeps latest.json + current apk; deletes older apks", () => {
    const plan = planPrune({
      listedNames: [
        "latest.json",
        "AgentCore-0.9.4-android.apk",
        "AgentCore-0.8.0-android.apk",
        "readme.md",
      ],
      kind: "android",
      currentVersion: "0.9.4",
      extraFilenames: androidArtifactNames("0.9.4"),
    });
    assert.ok(plan.keep.includes("latest.json"));
    assert.ok(plan.keep.includes("AgentCore-0.9.4-android.apk"));
    assert.ok(plan.keep.includes("readme.md"));
    assert.deepEqual(plan.delete, ["AgentCore-0.8.0-android.apk"]);
  });

  it("does not delete desktop installers in android dest", () => {
    const plan = planPrune({
      listedNames: ["AgentCore-0.8.0-win-x64.exe", "latest.json"],
      kind: "android",
      currentVersion: "0.9.4",
    });
    assert.ok(plan.keep.includes("AgentCore-0.8.0-win-x64.exe"));
    assert.deepEqual(plan.delete, []);
  });
});

describe("desktopArtifactNames", () => {
  it("includes zip used by mac updater plus both blockmaps", () => {
    const names = desktopArtifactNames("0.9.4");
    assert.ok(names.includes(macZipFilename("0.9.4")));
    assert.equal(names.length, 6);
  });
});
