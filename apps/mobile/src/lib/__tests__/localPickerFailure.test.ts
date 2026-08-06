import {
  isDesktopFolderAction,
  isLocalPickerFailureKind,
  localPickerFailureCopy,
} from "@/lib/localPickerFailure";
import { describe, expect, it } from "vitest";

describe("localPickerFailureCopy", () => {
  it("exposes fixed titles aligned with desktop", () => {
    expect(localPickerFailureCopy("dialog_failed").title).toContain(
      "未弹出文件夹选择器",
    );
    expect(localPickerFailureCopy("unauthorized").title).toContain(
      "未能授权本机目录",
    );
    expect(localPickerFailureCopy("no_package_json").title).toContain(
      "package.json",
    );
    expect(localPickerFailureCopy("unavailable").title).toContain(
      "本机目录仅桌面端可用",
    );
    expect(localPickerFailureCopy("unavailable").detail).toContain(
      "桌面客户端",
    );
    expect(isLocalPickerFailureKind("cancelled")).toBe(false);
    expect(isLocalPickerFailureKind("dialog_failed")).toBe(true);
    expect(isLocalPickerFailureKind("unavailable")).toBe(true);
  });

  it("prefers message detail for error / dialog_failed / unauthorized", () => {
    expect(localPickerFailureCopy("error", "自定义原因").detail).toBe(
      "自定义原因",
    );
    expect(localPickerFailureCopy("dialog_failed", "系统未能打开").detail).toBe(
      "系统未能打开",
    );
  });
});

describe("isDesktopFolderAction", () => {
  it("recognizes grant / bind / open actions", () => {
    expect(isDesktopFolderAction("grant_readonly_folder")).toBe(true);
    expect(isDesktopFolderAction("grant_organize_folder")).toBe(true);
    expect(isDesktopFolderAction("bind_local_folder")).toBe(true);
    expect(isDesktopFolderAction("open_local_project")).toBe(true);
    expect(isDesktopFolderAction(undefined)).toBe(false);
    expect(isDesktopFolderAction("continue_cloud")).toBe(false);
  });
});
