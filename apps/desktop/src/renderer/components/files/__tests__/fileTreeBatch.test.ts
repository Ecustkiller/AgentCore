import type { FileSource, FileSourceCaps } from "@/lib/fileSource";
import { describe, expect, it } from "vitest";
import { deleteRestoreHint } from "../fileTreeBatch";

function sourceWith(caps: Partial<FileSourceCaps>): FileSource {
  return {
    id: "s",
    label: "s",
    caps: {
      watch: false,
      transfer: false,
      edit: false,
      snapshots: false,
      ...caps,
    },
    listDir: async () => [],
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {},
    move: async () => {},
    delete: async () => {},
  };
}

describe("deleteRestoreHint", () => {
  it("promises OS recycle bin for local watch sources", () => {
    expect(deleteRestoreHint(sourceWith({ watch: true }))).toBe(
      "可从系统回收站还原。",
    );
  });

  it("promises product trash for snapshot (cloud) sources", () => {
    expect(deleteRestoreHint(sourceWith({ snapshots: true }))).toBe(
      "可从软删区还原。",
    );
  });

  it("warns irreversible when neither watch nor snapshots", () => {
    expect(deleteRestoreHint(sourceWith({}))).toBe("此操作不可撤销。");
  });
});
