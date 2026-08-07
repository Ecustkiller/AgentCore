import { describe, expect, it } from "vitest";
import {
  grantHintsFromAskOption,
  organizeConfirmDetail,
  previewOrganizeTargetLabel,
} from "../grantFolderHints";

describe("grantHintsFromAskOption", () => {
  it("returns undefined when neither hint is set", () => {
    expect(grantHintsFromAskOption({})).toBeUndefined();
    expect(grantHintsFromAskOption({ well_known: "home" })).toBeUndefined();
  });

  it("maps snake_case wire fields to camelCase IPC hints", () => {
    expect(
      grantHintsFromAskOption({
        well_known: "desktop",
        target_name: "  6月报表  ",
      }),
    ).toEqual({ wellKnown: "desktop", targetName: "6月报表" });
  });

  it("allows wellKnown alone", () => {
    expect(grantHintsFromAskOption({ well_known: "downloads" })).toEqual({
      wellKnown: "downloads",
    });
  });

  it("allows targetName alone", () => {
    expect(grantHintsFromAskOption({ target_name: "Docs" })).toEqual({
      targetName: "Docs",
    });
  });

  it("forwards mount path so preview and fulfill share the same hint", () => {
    expect(
      grantHintsFromAskOption({
        path: "C:\\Users\\me\\Desktop\\咨询",
        well_known: "desktop",
        target_name: "咨询",
      }),
    ).toEqual({
      path: "C:\\Users\\me\\Desktop\\咨询",
      wellKnown: "desktop",
      targetName: "咨询",
    });
    expect(
      grantHintsFromAskOption({ path: "  /home/me/Downloads/pack  " }),
    ).toEqual({ path: "/home/me/Downloads/pack" });
  });
});

describe("previewOrganizeTargetLabel", () => {
  it("synthesizes well_known + target_name as 桌面 › 咨询", () => {
    expect(
      previewOrganizeTargetLabel({
        well_known: "desktop",
        target_name: "咨询",
      }),
    ).toBe("桌面 › 咨询");
  });

  it("uses basename for absolute path (never full abs)", () => {
    expect(
      previewOrganizeTargetLabel({ path: "C:\\Users\\me\\Desktop\\咨询" }),
    ).toBe("咨询");
    expect(
      previewOrganizeTargetLabel({ path: "/home/me/Downloads/pack" }),
    ).toBe("pack");
  });

  it("falls back to well_known or target alone", () => {
    expect(previewOrganizeTargetLabel({ well_known: "documents" })).toBe(
      "文档",
    );
    expect(previewOrganizeTargetLabel({ target_name: "仅子名" })).toBe(
      "仅子名",
    );
  });
});

describe("organizeConfirmDetail", () => {
  it("prefixes 将整理 for grant_organize_folder", () => {
    expect(
      organizeConfirmDetail({
        action: "grant_organize_folder",
        well_known: "desktop",
        target_name: "咨询",
      }),
    ).toBe("将整理：桌面 › 咨询");
  });

  it("passes through detail for non-organize options", () => {
    expect(
      organizeConfirmDetail({
        action: "grant_readonly_folder",
        detail: "只读说明",
      }),
    ).toBe("只读说明");
  });
});
