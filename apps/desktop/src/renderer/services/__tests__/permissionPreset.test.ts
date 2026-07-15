import {
  autonomyToPreset,
  isPermissionDowngrade,
  presetToAutonomy,
} from "@/services/permissionPreset";
import { describe, expect, it } from "vitest";

describe("permissionPreset mapping", () => {
  it("maps autonomy ↔ preset", () => {
    expect(autonomyToPreset("always_ask")).toBe("observe");
    expect(autonomyToPreset("first_grant")).toBe("workspace");
    expect(autonomyToPreset("full_auto")).toBe("full_trust");
    expect(presetToAutonomy("observe")).toBe("always_ask");
    expect(presetToAutonomy("workspace")).toBe("first_grant");
    expect(presetToAutonomy("full_trust")).toBe("full_auto");
  });

  it("detects downgrades for StatusStrip confirm rules", () => {
    expect(isPermissionDowngrade("full_trust", "workspace")).toBe(true);
    expect(isPermissionDowngrade("workspace", "observe")).toBe(true);
    expect(isPermissionDowngrade("observe", "workspace")).toBe(false);
    expect(isPermissionDowngrade("workspace", "full_trust")).toBe(false);
  });
});
