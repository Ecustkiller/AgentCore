/**
 * 本机设备身份 IPC 契约 —— 履约通道（`GET /v1/fulfill`）的 `device_id`。
 *
 * 与安装绑定：落在 Electron `userData`（清安装/userData 才换新 id），主进程生成并
 * 持久化；渲染层只经 preload 读取，不自行 invent。
 */

export const DEVICE_IDENTITY_CHANNELS = {
  getDeviceId: "deviceIdentity:getDeviceId",
} as const;

export interface DeviceIdentityApi {
  /** 稳定 device_id；首次调用时生成并写入 userData。 */
  getDeviceId(): Promise<string>;
}
