/**
 * 本机设备身份（履约通道 `device_id`）——落 `userData/device-id.json`，与安装绑定。
 *
 * 小 JSON 直读写用户数据目录，约定同 `fs-roots.json` / `window-state.json`（不引第三方 store）。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_IDENTITY_CHANNELS } from "@shared/device-identity-contract";
import { app, ipcMain } from "electron";

interface DeviceIdFile {
  device_id?: unknown;
}

function deviceIdFilePath(): string {
  return join(app.getPath("userData"), "device-id.json");
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 读取或首次生成稳定 `device_id`（同步——连接履约通道前即可拿到）。
 * 文件缺失 / 损坏时生成新 UUID 并落盘。
 */
export function getOrCreateDeviceId(): string {
  try {
    const raw = JSON.parse(
      readFileSync(deviceIdFilePath(), "utf-8"),
    ) as DeviceIdFile;
    if (isValidDeviceId(raw.device_id)) return raw.device_id.trim();
  } catch {
    // 首次启动 / 文件损坏 → 下方生成。
  }

  const deviceId = randomUUID();
  try {
    writeFileSync(
      deviceIdFilePath(),
      JSON.stringify({ device_id: deviceId }, null, 2),
      "utf-8",
    );
  } catch (e) {
    console.error("[device-identity] 持久化 device_id 失败:", e);
  }
  return deviceId;
}

let registered = false;

/** 注册 `deviceIdentity:getDeviceId` IPC（幂等）。 */
export function registerDeviceIdentityIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle(DEVICE_IDENTITY_CHANNELS.getDeviceId, () =>
    getOrCreateDeviceId(),
  );
}
