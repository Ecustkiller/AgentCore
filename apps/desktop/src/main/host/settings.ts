import type { HostOpResult } from "@shared/host-contract";
import { shell } from "electron";
import { err, ok } from "./result";

/** L2 panel whitelist — keep closed (Host 定案 P1). */
const OPEN_SETTINGS_PANELS = new Set([
  "sound",
  "display",
  "network",
  "apps",
  "about",
]);

const WIN_SETTINGS_URI: Record<string, string> = {
  sound: "ms-settings:sound",
  display: "ms-settings:display",
  network: "ms-settings:network",
  apps: "ms-settings:appsfeatures",
  about: "ms-settings:about",
};

/** Best-effort mac System Settings / Preferences deep links. */
const MAC_SETTINGS_URI: Record<string, string> = {
  sound: "x-apple.systempreferences:com.apple.preference.sound",
  display: "x-apple.systempreferences:com.apple.preference.displays",
  network: "x-apple.systempreferences:com.apple.preference.network",
  // Apps / About have no stable preference pane URI on all macOS versions.
};

export async function openSettings(panel: string): Promise<HostOpResult> {
  if (!OPEN_SETTINGS_PANELS.has(panel)) {
    return err(`unsupported panel: ${panel}`);
  }
  if (process.platform === "win32") {
    const uri = WIN_SETTINGS_URI[panel];
    if (!uri) return err(`unsupported panel: ${panel}`);
    await shell.openExternal(uri);
    return ok({ opened: true, panel, uri });
  }
  if (process.platform === "darwin") {
    const uri = MAC_SETTINGS_URI[panel];
    if (!uri) {
      return ok({
        opened: false,
        panel,
        stub: true,
        note: "open_settings_panel_stub_on_mac",
      });
    }
    try {
      await shell.openExternal(uri);
      return ok({ opened: true, panel, uri });
    } catch {
      return ok({
        opened: false,
        panel,
        stub: true,
        note: "open_settings_stub_on_mac",
      });
    }
  }
  return ok({
    opened: false,
    panel,
    stub: true,
    note: "open_settings_not_implemented_on_this_os",
  });
}
