import { describe, expect, it } from "vitest";
import {
  formatWorkspaceLabel,
  resolveWorkspacePresentation,
} from "../teamPreviewWorkspace";

describe("resolveWorkspacePresentation", () => {
  it("returns none when no names", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_id: "f1" },
        { target_folder_id: "f2" },
      ]),
    ).toEqual({ mode: "none" });
  });

  it("summarizes when all desks match by id", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_id: "f1", target_folder_name: "本会话工作区" },
        { target_folder_id: "f1", target_folder_name: "本会话工作区" },
      ]),
    ).toEqual({ mode: "summary", name: "本会话工作区" });
  });

  it("summarizes when all desks match by name without id", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_name: "本会话工作区" },
        { target_folder_name: "本会话工作区" },
      ]),
    ).toEqual({ mode: "summary", name: "本会话工作区" });
  });

  it("uses perWorker when desks differ", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_id: "f1", target_folder_name: "云端甲" },
        { target_folder_id: "f2", target_folder_name: "云端乙" },
      ]),
    ).toEqual({ mode: "perWorker" });
  });

  it("uses perWorker when some rows lack a name", () => {
    expect(
      resolveWorkspacePresentation([{ target_folder_name: "云端甲" }, {}]),
    ).toEqual({ mode: "perWorker" });
  });
});

describe("formatWorkspaceLabel", () => {
  it("prefixes 工作区", () => {
    expect(formatWorkspaceLabel("本会话工作区")).toBe("工作区 · 本会话工作区");
  });
});
