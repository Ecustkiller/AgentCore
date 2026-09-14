/**
 * CLI 解析：默认预构建，--switch / --now 互斥。
 * Run: node --test deploy/scripts/remote-build-deploy.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRemoteDeployArgs } from "./remote-build-deploy.mjs";

describe("parseRemoteDeployArgs", () => {
  it("defaults to prepare", () => {
    assert.deepEqual(parseRemoteDeployArgs(["695cec861"]), {
      mode: "prepare",
      sha: "695cec861",
    });
  });

  it("accepts explicit --prepare after sha", () => {
    assert.deepEqual(parseRemoteDeployArgs(["695cec861", "--prepare"]), {
      mode: "prepare",
      sha: "695cec861",
    });
  });

  it("parses --switch before or after sha", () => {
    assert.deepEqual(parseRemoteDeployArgs(["--switch", "695cec861"]), {
      mode: "switch",
      sha: "695cec861",
    });
    assert.deepEqual(parseRemoteDeployArgs(["695cec861", "--switch"]), {
      mode: "switch",
      sha: "695cec861",
    });
  });

  it("parses --now", () => {
    assert.deepEqual(parseRemoteDeployArgs(["--now", "abc1234"]), {
      mode: "now",
      sha: "abc1234",
    });
  });

  it("strips a lone -- (pnpm extra-args)", () => {
    assert.deepEqual(parseRemoteDeployArgs(["--", "--switch", "695cec861"]), {
      mode: "switch",
      sha: "695cec861",
    });
  });

  it("rejects conflicting modes", () => {
    assert.throws(
      () => parseRemoteDeployArgs(["--prepare", "--switch", "695cec861"]),
      /conflicting modes/,
    );
  });

  it("rejects missing sha and unknown flags", () => {
    assert.throws(() => parseRemoteDeployArgs([]), /usage:/);
    assert.throws(() => parseRemoteDeployArgs(["--switch"]), /usage:/);
    assert.throws(() => parseRemoteDeployArgs(["--force", "695cec861"]), /unknown flag/);
    assert.throws(() => parseRemoteDeployArgs(["not-a-sha"]), /invalid SHA/);
  });
});

describe("cutover script pins", () => {
  const dir = dirname(fileURLToPath(import.meta.url));

  it("finish-server records last-deployed-sha after readyz and ignores oneshot orphans", () => {
    const text = readFileSync(join(dir, "finish-server.sh"), "utf8");
    assert.match(text, /COMPOSE_IGNORE_ORPHANS=1/);
    assert.match(text, /\.last-deployed-sha/);
    assert.match(text, /printf '%s\\n' "\$TAG" >"\$SHA_FILE"/);
  });

  it("backup.sh defaults BACKUP_KEEP to 7", () => {
    const text = readFileSync(join(dir, "backup.sh"), "utf8");
    assert.match(text, /BACKUP_KEEP="\$\{BACKUP_KEEP:-7\}"/);
    assert.doesNotMatch(text, /BACKUP_KEEP="\$\{BACKUP_KEEP:-14\}"/);
  });
});
