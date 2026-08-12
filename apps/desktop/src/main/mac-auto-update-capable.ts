/**
 * macOS 打包态：探测本机 .app 是否具备 Squirrel.Mac 自动更新所需的签名身份。
 *
 * Squirrel.Mac 硬校验 Developer ID（或 Apple Distribution）；未签名时全量下载也会在
 * 安装刻失败。用 `codesign --display` 能力探测（不匹配错误文案），仅 darwin +
 * `app.isPackaged` 探一次并缓存；异常/超时一律视为不可自动安装（降级手动更新）。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);

/** codesign 探测超时——超时按未签名处理（宁可手动，绝不误判可自动更新）。 */
const CODESIGN_TIMEOUT_MS = 5_000;

/**
 * 信任的叶证书 Authority 行（codesign -dv 输出）。
 * 不含「Developer ID Certification Authority」中间 CA——仅叶身份。
 */
const TRUSTED_AUTHORITY_RE =
  /^Authority=(Developer ID Application:|Apple Distribution:)/m;

let cached: Promise<boolean> | null = null;

/** 解析 `codesign --display --verbose=2` 输出，是否含可自动更新的签名身份。 */
export function hasTrustedMacCodesignAuthority(
  codesignDvOutput: string,
): boolean {
  return TRUSTED_AUTHORITY_RE.test(codesignDvOutput);
}

/** Packaged mac：`…/App.app/Contents/MacOS/Binary` → `…/App.app`。 */
export function macAppBundlePath(exePath = app.getPath("exe")): string {
  return path.resolve(exePath, "..", "..", "..");
}

async function probeOnce(): Promise<boolean> {
  try {
    const bundle = macAppBundlePath();
    // codesign --display 诊断信息历来写在 stderr；stdout 常为空。
    const { stdout, stderr } = await execFileAsync(
      "codesign",
      ["--display", "--verbose=2", bundle],
      { timeout: CODESIGN_TIMEOUT_MS, encoding: "utf8" },
    );
    const text = `${stdout ?? ""}\n${stderr ?? ""}`;
    return hasTrustedMacCodesignAuthority(text);
  } catch {
    return false;
  }
}

/**
 * 本机安装是否可走 Squirrel.Mac 自动更新安装路径。
 * 非 darwin / 未打包 → true（不适用手动降级）；darwin 打包态按 codesign 探测。
 */
export async function isMacAutoUpdateInstallCapable(): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return true;
  }
  if (!cached) {
    cached = probeOnce();
  }
  return cached;
}

/** @internal vitest only */
export function __resetMacAutoUpdateCapableCacheForTests(): void {
  cached = null;
}
