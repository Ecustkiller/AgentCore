// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { detectProjectRunCommands } from "@/lib/detectRunCommands";
import type { FileSource } from "@/lib/fileSource";

function mockSource(readImpl: FileSource["read"]): FileSource {
  return {
    id: "local:r1",
    label: "本地",
    caps: { watch: true, transfer: false, edit: true, snapshots: false },
    listDir: vi.fn(),
    read: readImpl,
    createFile: vi.fn(),
    mkdir: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
  };
}

describe("detectProjectRunCommands", () => {
  it("reads npm start/dev from package.json", async () => {
    const source = mockSource(async (path) => {
      if (path === "package.json") {
        return {
          kind: "text",
          text: JSON.stringify({
            scripts: { start: "node .", dev: "vite" },
          }),
          truncated: false,
        };
      }
      throw new Error("missing");
    });
    expect(await detectProjectRunCommands(source)).toEqual([
      "npm run start",
      "npm run dev",
    ]);
  });

  it("returns empty when no manifest files exist", async () => {
    const source = mockSource(async () => {
      throw new Error("missing");
    });
    expect(await detectProjectRunCommands(source)).toEqual([]);
  });
});
