/**
 * host_shell 环境隔离 + 观测纯函数单测。
 */
import { describe, expect, it } from "vitest";
import {
  buildHostShellEnv,
  fingerprintShellEnv,
  looksLikeGuiLaunch,
  shouldStripShellEnvKey,
} from "../host-shell-obs";

describe("host-shell-obs", () => {
  it("looksLikeGuiLaunch detects Start-Process / exe", () => {
    expect(
      looksLikeGuiLaunch(
        "Start-Process 'C:\\Users\\1\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe'",
      ),
    ).toBe(true);
    expect(looksLikeGuiLaunch("Write-Output 'p3ok'")).toBe(false);
  });

  it("fingerprintShellEnv lists Electron/vite keys and safe values only", () => {
    const fp = fingerprintShellEnv({
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      ELECTRON_EXEC_PATH: "C:\\Project\\AgentCore\\electron.exe",
      NODE_ENV_ELECTRON_VITE: "development",
      npm_package_name: "agentcore-desktop",
      SECRET_TOKEN: "should-not-appear-as-safe-value",
      PATH: "C:\\Windows",
    });
    expect(fp.electron_renderer_url_set).toBe(true);
    expect(fp.electron_exec_path_set).toBe(true);
    expect(fp.matching_keys).toContain("ELECTRON_RENDERER_URL");
    expect(fp.matching_keys).toContain("npm_package_name");
    expect(fp.matching_keys).not.toContain("SECRET_TOKEN");
    expect(fp.matching_keys).not.toContain("PATH");
    expect(fp.safe_values.ELECTRON_RENDERER_URL).toBe("http://localhost:5173");
    expect(fp.safe_values.npm_package_name).toBe("agentcore-desktop");
    expect(fp.safe_values).not.toHaveProperty("SECRET_TOKEN");
  });

  it("buildHostShellEnv strips Electron/vite identity but keeps PATH/APPDATA", () => {
    const parent = {
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\Users\\1\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\1",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      ELECTRON_EXEC_PATH: "C:\\Project\\AgentCore\\electron.exe",
      NODE_ENV_ELECTRON_VITE: "development",
      NODE_ENV: "development",
      npm_package_name: "agentcore-desktop",
      npm_lifecycle_script: "electron-vite dev",
      INIT_CWD: "C:\\Project\\AgentCore",
      PNPM_SCRIPT_SRC_DIR: "C:\\Project\\AgentCore\\apps\\desktop",
      NODE_PATH: "C:\\Project\\AgentCore\\node_modules",
      CHROME_CRASHPAD_PIPE_NAME: "\\\\.\\pipe\\crashpad_1",
      SECRET_KEEP: "ok",
    };
    const { env, stripped_keys } = buildHostShellEnv(parent);
    expect(env.PATH).toBe(parent.PATH);
    expect(env.APPDATA).toBe(parent.APPDATA);
    expect(env.USERPROFILE).toBe(parent.USERPROFILE);
    expect(env.SECRET_KEEP).toBe("ok");
    expect(env.NODE_ENV).toBe("development");
    expect(env.ELECTRON_RENDERER_URL).toBeUndefined();
    expect(env.ELECTRON_EXEC_PATH).toBeUndefined();
    expect(env.npm_package_name).toBeUndefined();
    expect(env.INIT_CWD).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(stripped_keys).toContain("ELECTRON_RENDERER_URL");
    expect(stripped_keys).toContain("npm_package_name");
    expect(shouldStripShellEnvKey("ELECTRON_RENDERER_URL")).toBe(true);
    expect(shouldStripShellEnvKey("PATH")).toBe(false);

    const childFp = fingerprintShellEnv(env);
    expect(childFp.electron_renderer_url_set).toBe(false);
    expect(childFp.electron_exec_path_set).toBe(false);
  });
});
