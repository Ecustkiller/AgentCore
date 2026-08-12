import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    dir: `${base}/device-identity-test-${Math.random().toString(36).slice(2)}`,
  };
});

vi.mock("electron", () => ({
  app: { getPath: () => h.dir },
  ipcMain: { handle: vi.fn() },
}));

import { getOrCreateDeviceId } from "../device-identity";

const idFile = join(h.dir, "device-id.json");

describe("getOrCreateDeviceId", () => {
  beforeEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
    mkdirSync(h.dir, { recursive: true });
  });
  afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

  it("generates and persists a device_id on first call", () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const disk = JSON.parse(readFileSync(idFile, "utf-8")) as {
      device_id: string;
    };
    expect(disk.device_id).toBe(id);
  });

  it("reuses the persisted device_id across calls", () => {
    writeFileSync(
      idFile,
      JSON.stringify({ device_id: "persisted-device-id" }, null, 2),
      "utf-8",
    );
    expect(getOrCreateDeviceId()).toBe("persisted-device-id");
    expect(getOrCreateDeviceId()).toBe("persisted-device-id");
  });

  it("regenerates when the file is corrupt", () => {
    writeFileSync(idFile, "{not json", "utf-8");
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const disk = JSON.parse(readFileSync(idFile, "utf-8")) as {
      device_id: string;
    };
    expect(disk.device_id).toBe(id);
  });
});
