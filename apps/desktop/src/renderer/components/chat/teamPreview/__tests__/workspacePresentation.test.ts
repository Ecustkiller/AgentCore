import { describe, expect, it } from "vitest";
import {
  formatWorkspaceLabel,
  resolveWorkspacePresentation,
} from "../workspacePresentation";

describe("resolveWorkspacePresentation", () => {
  it("hides when no server-resolved names (old frame)", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_id: "f1" },
        { target_folder_id: "f2" },
      ]),
    ).toEqual({ mode: "none" });
  });

  it("summarizes when all workers share the same desk name", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_name: "本会话工作区" },
        { target_folder_name: "本会话工作区" },
      ]),
    ).toEqual({ mode: "summary", name: "本会话工作区" });
  });

  it("summarizes when all workers share the same folder id", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_id: "proj-a", target_folder_name: "云端甲" },
        { target_folder_id: "proj-a", target_folder_name: "云端甲" },
      ]),
    ).toEqual({ mode: "summary", name: "云端甲" });
  });

  it("shows per worker when desk names differ", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_id: "a", target_folder_name: "项目甲" },
        { target_folder_id: "b", target_folder_name: "项目乙" },
        { target_folder_name: "本会话工作区" },
      ]),
    ).toEqual({ mode: "perWorker" });
  });

  it("shows per worker when some names are missing", () => {
    expect(
      resolveWorkspacePresentation([
        { target_folder_name: "本会话工作区" },
        {},
      ]),
    ).toEqual({ mode: "perWorker" });
  });
});

describe("formatWorkspaceLabel", () => {
  it("prefixes the display name", () => {
    expect(formatWorkspaceLabel("本会话工作区")).toBe("工作区 · 本会话工作区");
  });
});
