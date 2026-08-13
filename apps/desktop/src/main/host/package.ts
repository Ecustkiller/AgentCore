import { spawn } from "node:child_process";
import os from "node:os";
import type { HostOpResult } from "@shared/host-contract";
import { killProcessTree, treeSpawnOptions } from "../proc-tree";
import { err, ok } from "./result";

/** Keep in lockstep with server host_package_install timeout clamp. */
const PACKAGE_TIMEOUT_DEFAULT = 600;
const PACKAGE_TIMEOUT_MAX = 900;
const PACKAGE_OUTPUT_MAX = 200_000;

const PACKAGE_MANAGERS = new Set(["winget", "brew", "apt"]);
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-/@]{0,199}$/;

export function clampPackageTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "")
    return PACKAGE_TIMEOUT_DEFAULT;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return PACKAGE_TIMEOUT_DEFAULT;
  return Math.max(60, Math.min(PACKAGE_TIMEOUT_MAX, Math.trunc(n)));
}

function truncateOut(s: string): string {
  if (s.length <= PACKAGE_OUTPUT_MAX) return s;
  return `${s.slice(0, PACKAGE_OUTPUT_MAX)}\n…[truncated]`;
}

function validateArgs(
  manager: string,
  packageId: string,
  cask: boolean,
): string | null {
  if (!PACKAGE_MANAGERS.has(manager)) {
    return `manager not in allowlist: ${manager} (winget|brew|apt)`;
  }
  if (!packageId || !PACKAGE_ID_RE.test(packageId)) {
    return "invalid package_id";
  }
  if (cask && manager !== "brew") {
    return "cask=true is only valid for manager=brew";
  }
  return null;
}

function platformForManager(manager: string): string | null {
  if (manager === "winget" && process.platform !== "win32") {
    return "winget requires Windows";
  }
  if (
    manager === "brew" &&
    process.platform !== "darwin" &&
    process.platform !== "linux"
  ) {
    return "brew requires macOS or Linux";
  }
  if (manager === "apt" && process.platform !== "linux") {
    return "apt requires Linux";
  }
  return null;
}

function buildCommand(
  manager: string,
  packageId: string,
  cask: boolean,
): { file: string; args: string[]; shell?: boolean } {
  if (manager === "winget") {
    return {
      file: "winget",
      args: [
        "install",
        "--id",
        packageId,
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
    };
  }
  if (manager === "brew") {
    const args = ["install"];
    if (cask) args.push("--cask");
    args.push(packageId);
    return { file: "brew", args };
  }
  // apt — noninteractive; sudo -n fails fast if elevation needs a password.
  return {
    file: "sudo",
    args: [
      "-n",
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      "--",
      packageId,
    ],
  };
}

export async function hostPackageInstall(
  managerRaw: string,
  packageIdRaw: string,
  timeoutSeconds: number,
  cask = false,
): Promise<HostOpResult> {
  const manager = managerRaw.trim().toLowerCase();
  const packageId = packageIdRaw.trim();
  const invalid = validateArgs(manager, packageId, cask);
  if (invalid) {
    return err(invalid, "HostPackageInstallInvalid");
  }
  const platformMismatch = platformForManager(manager);
  if (platformMismatch) {
    return err(platformMismatch, "HostPackageInstallPlatform");
  }

  const { file, args } = buildCommand(manager, packageId, cask);
  const cwd = os.homedir();
  const timeoutMs = timeoutSeconds * 1000;

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      env: process.env,
      ...treeSpawnOptions(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (value: Record<string, unknown>) => {
      resolve(
        ok({
          manager,
          package_id: packageId,
          cask: cask || undefined,
          ...value,
        }),
      );
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 收整棵树：包管理器真正干活的是孙进程（winget → 安装器、apt → dpkg、
      // brew → curl/git），只杀前端会留下孤儿——它继续攥着包数据库锁，下一次
      // 安装照样失败（与 `.git/index.lock` 同一种病）。同样不等 kill、立刻回话。
      void killProcessTree(child);
      finish({
        timed_out: true,
        exit_code: null,
        stdout: truncateOut(stdout),
        stderr: truncateOut(stderr),
        cwd,
        note: `killed after ${timeoutSeconds}s`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    // 杀树会把读到一半的管道扯断，那不是执行失败，别让它变成未捕获错误。
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        err(
          e.message || "host_package_install spawn failed",
          "HostPackageInstallSpawnError",
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({
        timed_out: false,
        exit_code: code ?? null,
        stdout: truncateOut(stdout),
        stderr: truncateOut(stderr),
        cwd,
        argv: [file, ...args],
      });
    });
  });
}
