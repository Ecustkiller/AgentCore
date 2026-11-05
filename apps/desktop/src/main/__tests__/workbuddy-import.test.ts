import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "") },
  ipcMain: { handle: vi.fn() },
}));

import { readWorkBuddySkillBodies, scanWorkBuddy } from "../workbuddy-import";

describe("scanWorkBuddy", () => {
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nexus-workbuddy-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("discovers WorkBuddy and SkillHub skills with secrets removed", () => {
    const skill = join(home, ".workbuddy", "skills", "commit-helper");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: Commit Helper\ndescription: 分步提交\n---\n\n# Body\n",
    );

    const hub = join(home, ".workbuddyvpc", "skills", "video__skillhub");
    mkdirSync(hub, { recursive: true });
    writeFileSync(
      join(hub, "SKILL.md"),
      "---\nname: Video Skill\ndescription: >\n  folded\n  description\n---\n\n# Video\n",
    );
    writeFileSync(join(hub, "config.json"), '{"API_KEY":"secret"}');

    const result = scanWorkBuddy(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((item) => item.name)).toEqual([
      "Commit Helper",
      "Video Skill",
    ]);
    expect(result.skills[1].skillhub).toBe(true);
    expect(result.skills[1].description).toBe("folded description");
    expect(result.skills[1].configKeys).toEqual(["API_KEY"]);
    expect(readWorkBuddySkillBodies([result.skills[1].id])).toEqual([
      { id: result.skills[1].id, body: "# Video\n" },
    ]);
  });

  it("imports stdio MCP metadata without credential values", () => {
    mkdirSync(join(home, ".workbuddy"), { recursive: true });
    writeFileSync(
      join(home, ".workbuddy", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          helper: {
            command: "node",
            args: ["helper.js", "--token=real-secret"],
            env: {
              API_TOKEN: "real-secret",
              NO_PROXY: "localhost",
            },
          },
        },
      }),
    );

    const result = scanWorkBuddy(home);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]).toMatchObject({
      name: "helper",
      transport: "stdio",
      importable: true,
      credentialKeys: ["API_TOKEN", "args"],
      args: ["helper.js", ""],
      env: { API_TOKEN: "", NO_PROXY: "localhost" },
    });
    expect(JSON.stringify(result)).not.toContain("real-secret");
  });
});
