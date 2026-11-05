import { describe, expect, it } from "vitest";
import {
  detectSlashCommand,
  matchComposerCommands,
  removeSlashCommand,
} from "../composerCommands";

describe("composer commands", () => {
  it("detects slash commands only at the start of the draft", () => {
    expect(detectSlashCommand("/sk", 3)).toEqual({ start: 0, query: "sk" });
    expect(detectSlashCommand("  /模型", 5)).toEqual({
      start: 2,
      query: "模型",
    });
    expect(detectSlashCommand("read /etc", 9)).toBeNull();
    expect(detectSlashCommand("/skill foo", 10)).toBeNull();
    expect(detectSlashCommand("/Users/me", 9)).toBeNull();
  });

  it("matches Chinese and English aliases", () => {
    expect(matchComposerCommands("技能").map((item) => item.id)).toEqual([
      "skill",
    ]);
    expect(matchComposerCommands("model").map((item) => item.id)).toEqual([
      "model",
    ]);
    expect(matchComposerCommands("").map((item) => item.id)).toContain("stop");
  });

  it("removes only the slash command text", () => {
    expect(removeSlashCommand("/model 请分析", 0, "model")).toBe(" 请分析");
  });
});
