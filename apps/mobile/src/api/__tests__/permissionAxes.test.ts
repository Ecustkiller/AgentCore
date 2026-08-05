import {
  DEFAULT_PERMISSION_AXES,
  RECIPE_AXES,
  RECIPE_ORDER,
  axesEqual,
  axesShortLabel,
  isIllegalAxes,
  matchRecipe,
  needsAutoCommandConfirm,
  normalizeAxes,
  recipeToAxes,
  setConversationPermissionAxes,
} from "@/api/permissionAxes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/api/autonomy", () => ({
  setAutonomy: vi.fn(async (policy: string) => ({ policy })),
}));

import { apiFetch } from "@/api/client";

const mockFetch = vi.mocked(apiFetch);

describe("permissionAxes mapping", () => {
  it("maps recipes ↔ axes", () => {
    expect(recipeToAxes("cautious")).toEqual(RECIPE_AXES.cautious);
    expect(recipeToAxes("less_interrupt")).toEqual(RECIPE_AXES.less_interrupt);
    expect(recipeToAxes("managed")).toEqual(RECIPE_AXES.managed);
    expect(RECIPE_ORDER).toEqual(["cautious", "less_interrupt", "managed"]);
    expect(axesEqual(RECIPE_AXES.cautious, RECIPE_AXES.managed)).toBe(false);
  });

  it("matches recipes and reports custom", () => {
    expect(matchRecipe(RECIPE_AXES.less_interrupt)).toBe("less_interrupt");
    expect(
      matchRecipe({
        file_write: "session",
        command: "ask",
        team_kickoff: "rules",
        host: "ask",
      }),
    ).toBe("custom");
  });

  it("rejects illegal auto+ask and normalizes", () => {
    expect(
      isIllegalAxes({
        file_write: "ask",
        command: "auto",
        team_kickoff: "skip",
        host: "ask",
      }),
    ).toBe(true);
    expect(
      normalizeAxes({
        file_write: "ask",
        command: "auto",
        team_kickoff: "skip",
        host: "ask",
      }),
    ).toEqual(DEFAULT_PERMISSION_AXES);
  });

  it("flags auto-command confirm only on enter", () => {
    expect(
      needsAutoCommandConfirm(RECIPE_AXES.cautious, RECIPE_AXES.less_interrupt),
    ).toBe(true);
    expect(
      needsAutoCommandConfirm(RECIPE_AXES.less_interrupt, RECIPE_AXES.managed),
    ).toBe(false);
  });

  it("resolves short labels", () => {
    expect(axesShortLabel(RECIPE_AXES.cautious)).toBe("谨慎");
    expect(axesShortLabel(RECIPE_AXES.less_interrupt)).toBe("少打断");
    expect(axesShortLabel(RECIPE_AXES.managed)).toBe("托管");
    expect(
      axesShortLabel({
        file_write: "session",
        command: "ask",
        team_kickoff: "always",
        host: "ask",
      }),
    ).toBe("信任 · 每次 · 总挂 · 本机问");
  });
});

describe("setConversationPermissionAxes", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("PUTs permission-axes and returns normalized axes", async () => {
    const next = RECIPE_AXES.managed;
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ permission_axes: next }), { status: 200 }),
    );
    const saved = await setConversationPermissionAxes("c1", next);
    expect(saved).toEqual(next);
    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/conversations/c1/permission-axes",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ permission_axes: next }),
      }),
    );
  });

  it("rejects illegal axes before fetch", async () => {
    await expect(
      setConversationPermissionAxes("c1", {
        file_write: "ask",
        command: "auto",
        team_kickoff: "rules",
        host: "off",
      }),
    ).rejects.toThrow(/非法权限组合/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces API error message", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "会话不存在" } }), {
        status: 404,
      }),
    );
    await expect(
      setConversationPermissionAxes("missing", RECIPE_AXES.cautious),
    ).rejects.toThrow("会话不存在");
  });
});
